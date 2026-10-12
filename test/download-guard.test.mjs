// F-02: every entry a download will write is validated against the local policy, not just the destination folder.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { assertSafeEntryName, validateStaged } from "../dist/services/downloadGuard.js";

describe("assertSafeEntryName", () => {
  it("rejects names that cannot be a single, plain path component", () => {
    for (const n of ["", ".", "..", "a/b", "..\\x", "a\\b", "x\u0000y", "x\ny", "../../.ssh/authorized_keys"]) {
      assert.throws(() => assertSafeEntryName(n), /unsafe|empty|must not/i, JSON.stringify(n));
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

describe("validateStaged limits", () => {
  it("refuses more than 100000 entries", () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      mkdirSync(join(d, "top"));
      for (let i = 0; i < 100_001; i++) writeFileSync(join(d, "top", `f${i}`), "");
      assert.throws(() => validateStaged(d), /more than 100000 entries/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("fails closed when an entry cannot be inspected", () => {
    assert.throws(() => validateStaged(join(tmpdir(), "does-not-exist-" + Math.random())));
  });
});
