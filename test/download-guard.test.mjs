// F-02: every entry a download will write is validated against the local policy, not just the destination folder.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { assertSafeEntryName, scanStaged } from "../dist/services/downloadGuard.js";
import { planDownload } from "../dist/services/downloadPlan.js";

describe("assertSafeEntryName", () => {
  it("rejects names that cannot be a single, plain path component", () => {
    for (const n of ["", ".", "..", "a/b", "..\\x", "a\\b", "x\u0000y", "x\ny", "../../.ssh/authorized_keys", "invoice\u202Egpj.exe", "a\u200Bb", "\uFEFFname"]) {
      assert.throws(() => assertSafeEntryName(n), /unsafe|empty|must not|invisible/i, JSON.stringify(n));
    }
  });
  it("accepts ordinary names, and dotfiles below the top level", () => {
    for (const n of ["report.pdf", "a b", "ünï.txt", "x..y"]) assertSafeEntryName(n);
    assertSafeEntryName(".gitignore");
    assert.throws(() => assertSafeEntryName(".gitignore", { top: true }), /starts with '\.'/);
  });
});

describe("drive_download / photos_download validate remote entries", () => {
  let base;
  before(() => { base = mkdtempSync(join(tmpdir(), "dlguard-")); });
  after(() => rmSync(base, { recursive: true, force: true }));

  const treeFile = (obj) => { const p = join(base, `tree-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(obj)); return p; };
  const folderNode = { type: "folder", name: { ok: true, value: "x" } };
  const fileNode = (name) => ({ uid: "u1", type: "file", name: { ok: true, value: name }, activeRevision: { claimedSize: 1 } });
  const item = (name, type = "file") => ({ uid: `uid-${name}`, type, name: { ok: true, value: name } });

  async function run(tree, tool, args, env = {}) {
    const sb = makeSandbox();
    const c = await startServer("tree", sb, { FAKE_TREE: treeFile(tree), ...env });
    try {
      const r = await c.call(tool, args);
      return { r, calls: nonVersionCalls(sb.argvLog) };
    } finally { await c.close(); sb.cleanup(); }
  }
  const downloads = (calls) => calls.filter((a) => a[1] === "download" || a[0] === "photo");

  it("refuses a remote top-level name starting with '.' before any download call", async () => {
    const dest = join(base, "d1");
    const { r, calls } = await run({ __info__: { "/my-files/.ssh": folderNode }, "/my-files/.ssh": [item("authorized_keys")] }, "drive_download", { remotePath: "/my-files/.ssh", localPath: dest });
    assert.equal(r.isError, true);
    assert.match(r.text, /starts with '\.'/);
    assert.deepEqual(downloads(calls), []);
    assert.equal(existsSync(dest), false);
  });

  it("refuses destination ~ plus a hidden remote file", async () => {
    const { r, calls } = await run({ __info__: { "/my-files/.bashrc": fileNode(".bashrc") } }, "drive_download", { remotePath: "/my-files/.bashrc", localPath: homedir() });
    assert.equal(r.isError, true);
    assert.deepEqual(downloads(calls), []);
  });

  it("refuses a top-level secret-looking name even in an allowed folder (NAME_DENY on the final target)", async () => {
    const { r, calls } = await run({ __info__: { "/my-files/id_rsa": fileNode("id_rsa") } }, "drive_download", { remotePath: "/my-files/id_rsa", localPath: join(base, "d2") });
    assert.equal(r.isError, true);
    assert.deepEqual(downloads(calls), []);
  });

  it("refuses a folder whose descendant name would traverse (name containing '/')", async () => {
    const dest = join(base, "d3");
    const { r, calls } = await run({
      __info__: { "/my-files/proj": folderNode },
      "/my-files/proj": [item("ok.txt"), item("..\\/..\\/..\\/.ssh\\/authorized_keys")],
    }, "drive_download", { remotePath: "/my-files/proj", localPath: dest });
    assert.equal(r.isError, true);
    assert.match(r.text, /unsafe entry name/);
    assert.deepEqual(downloads(calls), []);
  });

  it("refuses when the remote tree cannot be fully enumerated (fail closed)", async () => {
    const { r, calls } = await run({
      __info__: { "/my-files/proj": folderNode },
      "/my-files/proj": [item("sub", "folder")],
      "/my-files/proj/sub": "boom: transient failure",
    }, "drive_download", { remotePath: "/my-files/proj", localPath: join(base, "d4") });
    assert.equal(r.isError, true);
    assert.match(r.text, /could not be fully listed/);
    assert.deepEqual(downloads(calls), []);
  });

  it("allows a normal folder: the CLI writes to a staging dir beside the destination, the result lands in the destination", async () => {
    const dest = join(base, "d5", "nested");
    const { r, calls } = await run({
      __info__: { "/my-files/proj": folderNode },
      "/my-files/proj": [item("a.txt"), item(".gitignore"), item("sub", "folder")],
      "/my-files/proj/sub": [item("b.txt")],
    }, "drive_download", { remotePath: "/my-files/proj", localPath: dest }, { FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "proj/a.txt" }, { rel: "proj/.gitignore" }, { rel: "proj/sub/b.txt" }]) });
    assert.equal(r.isError, false, r.text);
    const argv = downloads(calls)[0];
    assert.equal(realpathSync(dirname(argv[3])), realpathSync(dirname(dest)), "staging is beside the destination");
    assert.match(basename(argv[3]), /^\.pdmcp-stage-/);
    assert.notEqual(argv[3], dest);
    assert.equal(statSync(dest).mode & 0o777, 0o700);
    assert.equal(existsSync(join(dest, "proj", "sub", "b.txt")), true);
    assert.equal(existsSync(argv[3]), false, "staging removed");
  });

  it("single file: one info call, no tree walk", async () => {
    const { r, calls } = await run({ __info__: { "/my-files/a.txt": fileNode("a.txt") } }, "drive_download", { remotePath: "/my-files/a.txt", localPath: join(base, "d6") });
    assert.equal(r.isError, false, r.text);
    assert.ok(!calls.some((a) => a[1] === "list"));
  });

  const stageResidue = (dir) => readdirSync(dir).filter((n) => n.startsWith(".pdmcp-stage-"));
  const folderTree = (extra = {}) => ({
    __info__: { "/my-files/proj": folderNode },
    "/my-files/proj": [item("a.txt")],
    ...extra,
  });
  async function stagedRefusal(label, writes, match, env = {}) {
    const root = mkdtempSync(join(base, "case-"));
    const dest = join(root, "dest");
    const { r } = await run(folderTree(), "drive_download", { remotePath: "/my-files/proj", localPath: dest },
      { FAKE_DOWNLOAD_WRITE: JSON.stringify(writes), ...env });
    assert.equal(r.isError, true, `${label}: ${r.text}`);
    assert.match(r.text, match, label);
    assert.deepEqual(existsSync(dest) ? readdirSync(dest) : [], [], `${label}: nothing may reach the destination`);
    assert.deepEqual(stageResidue(root), [], `${label}: staging removed`);
  }

  it("a symlink created by the CLI refuses the whole download; nothing reaches the destination", () =>
    stagedRefusal("symlink", [{ rel: "proj/a.txt" }, { rel: "proj/evil", symlinkTo: "/etc/passwd" }], /symlink/));
  it("a hardlink refuses", async () => {
    const outside = join(base, "outside-file"); writeFileSync(outside, "secret");
    await stagedRefusal("hardlink", [{ rel: "proj/a.txt" }, { rel: "proj/h", hardlinkTo: outside }], /hardlink/);
  });
  it("a FIFO refuses", () => stagedRefusal("fifo", [{ rel: "proj/a.txt" }, { rel: "proj/p", fifo: true }], /FIFO|not a regular/));
  // On case-insensitive volumes (default macOS/Windows) the filesystem itself merges such names, so only Linux can show it.
  it("names differing only by case collide and refuse", { skip: ["darwin", "win32"].includes(process.platform) && "case-insensitive filesystem" }, () =>
    stagedRefusal("case", [{ rel: "proj/A.txt" }, { rel: "proj/a.txt" }], /collide/));
  it("an unexpected top-level entry refuses", () =>
    stagedRefusal("extra top", [{ rel: "proj/a.txt" }, { rel: "other.txt" }], /unexpected entries/));
  it("more bytes than PROTON_DRIVE_DOWNLOAD_MAX_BYTES refuses", () =>
    stagedRefusal("bytes", [{ rel: "proj/a.txt", content: "0123456789" }], /MAX_BYTES/, { PROTON_DRIVE_DOWNLOAD_MAX_BYTES: "5" }));
  it("a transfer that dies mid-way leaves nothing behind", () =>
    stagedRefusal("fail", [{ rel: "proj/a.txt" }], /connection lost|CLI/, { FAKE_DOWNLOAD_FAIL: "1" }));

  it("setuid/exec bits from the remote side are not kept on the final file", async () => {
    const dest = join(mkdtempSync(join(base, "mode-")), "dest");
    const { r } = await run(folderTree(), "drive_download", { remotePath: "/my-files/proj", localPath: dest }, { FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "proj/a.txt", mode: 0o4777 }]) });
    assert.equal(r.isError, false, r.text);
    const mode = statSync(join(dest, "proj", "a.txt")).mode & 0o7777;
    assert.equal(mode & 0o7000, 0);
    assert.equal(mode & 0o111, 0);
    assert.equal(mode & 0o022, 0);
  });

  it("the destination swapped for a symlink to a protected place during the transfer is refused", async () => {
    const root = mkdtempSync(join(base, "swap-"));
    const dest = join(root, "dest");
    mkdirSync(dest);
    const { r } = await run(folderTree(), "drive_download", { remotePath: "/my-files/proj", localPath: dest },
      { FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "proj/a.txt" }]), FAKE_DOWNLOAD_SWAP: JSON.stringify({ path: dest, to: "/etc" }) });
    assert.equal(r.isError, true, r.text);
    assert.equal(existsSync("/etc/proj"), false);
    assert.deepEqual(stageResidue(root), []);
  });

  it("an error in the middle of placing (merge into a folder holding a symlink) rolls back what was placed", async () => {
    const root = mkdtempSync(join(base, "mid-"));
    const dest = join(root, "dest");
    const outside = join(root, "outside"); mkdirSync(outside);
    mkdirSync(join(dest, "proj"), { recursive: true });
    symlinkSync(outside, join(dest, "proj", "sub"));
    const { r } = await run({
      __info__: { "/my-files/proj": folderNode },
      "/my-files/proj": [item("a.txt"), item("sub", "folder")],
      "/my-files/proj/sub": [item("b.txt")],
    }, "drive_download", { remotePath: "/my-files/proj", localPath: dest, folderConflictStrategy: "merge" },
      { FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "proj/a.txt" }, { rel: "proj/sub/b.txt" }]) });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /symlink/);
    assert.equal(existsSync(join(dest, "proj", "a.txt")), false, "a.txt placed before the failure is rolled back");
    assert.deepEqual(readdirSync(outside), [], "nothing written through the symlink");
    assert.deepEqual(stageResidue(root), []);
  });

  it("conflict strategies are applied by the server: skip keeps, rename adds a unique name, remove replaces", async () => {
    for (const [strategy, expect] of [["skip", { keep: "old", extra: false }], ["rename", { keep: "old", extra: true }], ["remove", { keep: "x", extra: false }]]) {
      const root = mkdtempSync(join(base, `strat-${strategy}-`));
      const dest = join(root, "dest");
      mkdirSync(join(dest), { recursive: true });
      writeFileSync(join(dest, "a.txt"), "old");
      const { r } = await run({ __info__: { "/my-files/a.txt": fileNode("a.txt") } }, "drive_download",
        { remotePath: "/my-files/a.txt", localPath: dest, fileConflictStrategy: strategy, ...(strategy === "remove" ? { confirmed: true } : {}) },
        { FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "a.txt", content: "x" }]) });
      assert.equal(r.isError, false, `${strategy}: ${r.text}`);
      assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), expect.keep, strategy);
      assert.equal(existsSync(join(dest, "a (1).txt")), expect.extra, strategy);
      if (strategy === "skip") assert.equal(JSON.parse(r.text).skipped, 1);
    }
  });

  it("photos_download refuses a hidden photo name and runs nothing", async () => {
    const { r, calls } = await run({}, "photos_download", { photoPaths: ["/photos/.hidden.jpg"], localFolder: join(base, "p1") });
    assert.equal(r.isError, true);
    assert.deepEqual(downloads(calls), []);
  });

  it("photos_download accepts ordinary names", async () => {
    const { r, calls } = await run({}, "photos_download", { photoPaths: ["/photos/IMG_1.jpg"], localFolder: join(base, "p2") });
    assert.equal(r.isError, false, r.text);
    assert.equal(downloads(calls).length, 1);
  });
});

describe("scanStaged limits", () => {
  it("refuses more than 100000 entries", () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      mkdirSync(join(d, "top"));
      for (let i = 0; i < 100_001; i++) writeFileSync(join(d, "top", `f${i}`), "");
      assert.throws(() => scanStaged(d), /more than 100000 entries/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("fails closed when an entry cannot be inspected", () => {
    assert.throws(() => scanStaged(join(tmpdir(), "does-not-exist-" + Math.random())));
  });
});

// ---- planDownload: pure, so it can be hammered with generated inputs ----
const F = (name) => ({ name, kind: "file", children: [], files: 1 });
const D = (name, ...children) => ({ name, kind: "dir", children, files: children.reduce((n, c) => n + c.files, 0) });
const lookupOf = (m) => (rel) => m[rel];

describe("planDownload", () => {
  const skip = { file: "skip", folder: "skip" };
  it("places absent targets and skips existing ones under skip", () => {
    const plan = planDownload([F("a.txt"), F("b.txt")], lookupOf({ "a.txt": { kind: "file" } }), skip);
    assert.deepEqual(plan.map((a) => a.op + ":" + (a.dstRel ?? a.srcRel)), ["skip:a.txt", "place:b.txt"]);
  });
  it("refuses to touch an existing symlink or special file, whatever the strategy", () => {
    for (const kind of ["symlink", "other"]) for (const file of ["skip", "rename", "remove"]) {
      assert.throws(() => planDownload([F("a")], lookupOf({ a: { kind } }), { file, folder: "skip" }), /exists locally as a/);
    }
  });
  it("rename picks a free name and never plans an overwrite", () => {
    const plan = planDownload([F("a.txt")], lookupOf({ "a.txt": { kind: "file" }, "a (1).txt": { kind: "file" } }), { file: "rename", folder: "skip" });
    assert.deepEqual(plan, [{ op: "place", srcRel: "a.txt", dstRel: "a (2).txt", kind: "file" }]);
  });
  it("remove: file replaces file only; never a directory, never a type mismatch", () => {
    const p = { file: "remove", folder: "remove" };
    assert.deepEqual(planDownload([F("a")], lookupOf({ a: { kind: "file" } }), p).map((x) => x.op), ["unlink", "place"]);
    assert.throws(() => planDownload([F("a")], lookupOf({ a: { kind: "dir", empty: true } }), p), /locally but a file remotely|is a dir/);
    assert.throws(() => planDownload([D("a")], lookupOf({ a: { kind: "file" } }), p), /is a file locally/);
  });
  it("remove: a non-empty local folder is never deleted, an empty one may be replaced", () => {
    const p = { file: "remove", folder: "remove" };
    assert.throws(() => planDownload([D("d", F("x"))], lookupOf({ d: { kind: "dir", empty: false } }), p), /non-empty local folder/);
    assert.deepEqual(planDownload([D("d")], lookupOf({ d: { kind: "dir", empty: true } }), p).map((x) => x.op), ["rmdir", "place"]);
  });
  it("merge: dir onto dir only, existing files are kept (skip) and never overwritten", () => {
    const p = { file: "skip", folder: "merge" };
    const plan = planDownload([D("d", F("old"), F("new"))], lookupOf({ d: { kind: "dir" }, "d/old": { kind: "file" } }), p);
    assert.deepEqual(plan.map((a) => a.op + ":" + (a.dstRel ?? a.srcRel)), ["skip:d/old", "place:d/new"]);
    assert.throws(() => planDownload([D("d")], lookupOf({ d: { kind: "file" } }), p), /merge only combines/);
    assert.throws(() => planDownload([D("d", F("x"))], lookupOf({ d: { kind: "dir" }, "d/x": { kind: "file" } }), { file: "remove", folder: "merge" }), /never overwrites/);
  });
  it("refuses staged symlinks, FIFOs and colliding top-level names", () => {
    assert.throws(() => planDownload([{ name: "l", kind: "symlink", children: [], files: 0 }], lookupOf({}), skip), /symlink/);
    assert.throws(() => planDownload([{ name: "p", kind: "other", children: [], files: 0 }], lookupOf({}), skip), /not a regular/);
    assert.throws(() => planDownload([F("A"), F("a")], lookupOf({}), skip), /collide/);
  });

  // Generated inputs: whatever the strategies and existing state, a returned plan never overwrites, never leaves the
  // destination, and only ever acts on regular files and folders.
  it("property: no plan overwrites an existing item or escapes the destination", () => {
    let seed = 20260711;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const names = ["a", "b", "c.txt", "d.tar.gz", "e"];
    const kinds = ["file", "dir", "symlink", "other"];
    for (let i = 0; i < 3000; i++) {
      const gen = (depth) => {
        const n = names.length;
        const out = [];
        for (const nm of names.slice(0, 1 + Math.floor(rnd() * n))) {
          const isDir = depth < 2 && rnd() < 0.4;
          out.push(isDir ? D(nm, ...gen(depth + 1)) : (rnd() < 0.08 ? { name: nm, kind: pick(["symlink", "other"]), children: [], files: 0 } : F(nm)));
        }
        return out;
      };
      const top = gen(0);
      const existing = {};
      const mark = (nodes, parent) => {
        for (const nd of nodes) {
          const rel = parent ? `${parent}/${nd.name}` : nd.name;
          if (rnd() < 0.5) existing[rel] = { kind: pick(kinds), empty: rnd() < 0.5 };
          if (nd.kind === "dir") mark(nd.children, rel);
        }
      };
      mark(top, "");
      const policy = { file: pick(["skip", "rename", "remove"]), folder: pick(["skip", "merge", "rename", "remove"]) };
      let plan;
      try { plan = planDownload(top, lookupOf(existing), policy); } catch { continue; }
      const gone = new Set();
      for (const a of plan) {
        if (a.op === "unlink") { assert.equal(existing[a.dstRel]?.kind, "file"); gone.add(a.dstRel); continue; }
        if (a.op === "rmdir") { assert.equal(existing[a.dstRel]?.kind, "dir"); assert.equal(existing[a.dstRel]?.empty, true); gone.add(a.dstRel); continue; }
        if (a.op === "skip") continue;
        assert.ok(!a.dstRel.split("/").some((s) => s === ".." || s === "." || s === ""), a.dstRel);
        assert.ok(existing[a.dstRel] === undefined || gone.has(a.dstRel), `would overwrite ${a.dstRel}`);
      }
    }
  });
});
