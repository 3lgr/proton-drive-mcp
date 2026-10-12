// F-04: uploads run from a validated private snapshot; any doubt refuses and nothing is sent.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, chmodSync, utimesSync, readdirSync, readFileSync, existsSync, renameSync, unlinkSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { planUploadSnapshot, precheckUpload, withUploadSnapshot } from "../dist/services/uploadSnapshot.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const N = (name, kind = "file", children = [], extra = {}) => ({ name, kind, size: 1, nlink: 1, dev: 1, ino: 1, mtimeMs: 1, children, ...extra });
const limits = (over = {}) => ({ maxEntries: 100, maxBytes: 100, isProtected: (_rel, name) => /^\.env$|\.pem$/.test(name), ...over });

describe("planUploadSnapshot (pure)", () => {
  it("lists directories before their files, in tree order", () => {
    const plan = planUploadSnapshot(N("r", "dir", [N("a"), N("s", "dir", [N("b")])]), limits());
    assert.deepEqual(plan.map((a) => `${a.op}:${a.rel}`), ["mkdir:", "copy:a", "mkdir:s", "copy:s/b"]);
  });
  it("refuses: root symlink, nested symlink, FIFO/special, hardlink, other filesystem, secret names", () => {
    assert.throws(() => planUploadSnapshot(N("r", "symlink"), limits()), /symlink/);
    assert.throws(() => planUploadSnapshot(N("r", "dir", [N("l", "symlink")]), limits()), /symlink/);
    assert.throws(() => planUploadSnapshot(N("r", "dir", [N("p", "other")]), limits()), /FIFO/);
    assert.throws(() => planUploadSnapshot(N("r", "dir", [N("h", "file", [], { nlink: 2 })]), limits()), /hardlink/);
    assert.throws(() => planUploadSnapshot(N("r", "dir", [N("m", "dir", [], { dev: 2 })]), limits()), /another filesystem/);
    assert.throws(() => planUploadSnapshot(N("r", "dir", [N("d", "dir", [N(".env")])]), limits()), /secret or protected/);
  });
  it("enforces entry and byte limits, and depth", () => {
    assert.throws(() => planUploadSnapshot(N("r", "dir", [N("a"), N("b"), N("c")]), limits({ maxEntries: 3 })), /more than 3 entries/);
    assert.throws(() => planUploadSnapshot(N("r", "dir", [N("a", "file", [], { size: 60 }), N("b", "file", [], { size: 60 })]), limits()), /more than 100 bytes/);
    let deep = N("leaf");
    for (let i = 0; i < 70; i++) deep = N("d" + i, "dir", [deep]);
    assert.throws(() => planUploadSnapshot(deep, limits({ maxEntries: 1000 })), /too deep/);
  });
});

describe("upload tools send a snapshot", () => {
  let base;
  before(() => { base = mkdtempSync(join(tmpdir(), "upsnap-")); });
  after(() => rmSync(base, { recursive: true, force: true }));
  const tree = (files) => {
    const d = mkdtempSync(join(base, "t-"));
    for (const [rel, c] of Object.entries(files)) { mkdirSync(dirname(join(d, rel)), { recursive: true }); writeFileSync(join(d, rel), c); }
    return d;
  };
  // Each server gets its own TMPDIR so snapshot counts are not disturbed by suites running in parallel.
  let serverTmp;
  const snapshotsLeft = () => readdirSync(serverTmp).filter((n) => n.startsWith("pdmcp-upload-"));

  async function upload(tool, args, env = {}) {
    const sb = makeSandbox();
    serverTmp = mkdtempSync(join(base, "tmp-"));
    const cap = join(sb.dir, "capture.json");
    const c = await startServer("tree", sb, { FAKE_TREE: join(sb.dir, "tree.json"), FAKE_UPLOAD_CAPTURE: cap, TMPDIR: serverTmp, ...env });
    writeFileSync(join(sb.dir, "tree.json"), "{}");
    try {
      const r = await c.call(tool, args);
      return { r, calls: nonVersionCalls(sb.argvLog), capture: existsSync(cap) ? JSON.parse(readFileSync(cap, "utf8")) : null };
    } finally { await c.close(); sb.cleanup(); }
  }

  it("uploads a copy: other path, same base name, same bytes and mtime, removed afterwards", async () => {
    const d = tree({ "p/a.txt": "alpha", "p/sub/b.txt": "beta" });
    const when = new Date("2024-03-04T05:06:07Z");
    utimesSync(join(d, "p", "a.txt"), when, when);
    const { r, capture } = await upload("drive_upload", { localPath: join(d, "p"), remotePath: "/my-files" });
    assert.equal(r.isError, false, r.text);
    assert.notEqual(capture.path, join(d, "p"));
    assert.match(capture.path, /pdmcp-upload-/);
    assert.equal(basename(capture.path), "p");
    assert.equal(capture.files["a.txt"].content, "alpha");
    assert.equal(capture.files["sub/b.txt"].content, "beta");
    assert.equal(Math.round(capture.files["a.txt"].mtimeMs / 1000), Math.round(when.getTime() / 1000));
    assert.equal(capture.files["a.txt"].mode, 0o600);
    assert.equal(existsSync(capture.path), false, "snapshot removed");
    assert.equal(snapshotsLeft().length, 0);
  });

  it("a single file is snapshotted too", async () => {
    const d = tree({ "f.txt": "hello" });
    const { r, capture } = await upload("drive_upload", { localPath: join(d, "f.txt"), remotePath: "/my-files" });
    assert.equal(r.isError, false, r.text);
    assert.notEqual(capture.path, join(d, "f.txt"));
    assert.equal(basename(capture.path), "f.txt");
    assert.equal(capture.files["f.txt"].content, "hello");
  });

  const refused = async (label, mk, match, env = {}) => {
    const root = mk();
    const { r, calls } = await upload("drive_upload", { localPath: root, remotePath: "/my-files" }, env);
    assert.equal(r.isError, true, `${label}: ${r.text}`);
    assert.match(r.text, match, label);
    assert.deepEqual(calls, [], `${label}: nothing may reach the CLI`);
    assert.equal(snapshotsLeft().length, 0, `${label}: snapshot removed`);
  };

  it("refuses a nested symlink", () => refused("symlink", () => { const d = tree({ "ok.txt": "1" }); symlinkSync("/etc/hosts", join(d, "l")); return d; }, /symlink/));
  it("refuses when the root itself is a symlink", () => refused("root symlink", () => { const d = tree({ "ok.txt": "1" }); const l = join(base, "rootlink-" + Math.random().toString(36).slice(2)); symlinkSync(d, l); return l; }, /symlink/));
  it("refuses a hardlink", () => refused("hardlink", () => { const d = tree({ "ok.txt": "1", "x/y.txt": "2" }); linkSync(join(d, "x", "y.txt"), join(d, "y2.txt")); return d; }, /hardlink/));
  it("refuses a FIFO", () => refused("fifo", () => { const d = tree({ "ok.txt": "1" }); execFileSync("mkfifo", [join(d, "p")]); return d; }, /FIFO/));
  it("refuses a secret anywhere in the tree", () => refused("secret", () => tree({ "ok.txt": "1", "a/b/.env": "S=1" }), /secret or protected/));
  it("refuses a missing path (fail closed, not 'let the CLI find out')", () => refused("missing", () => join(base, "does-not-exist"), /ENOENT|no such file/i));
  it("refuses an unreadable file: the copy error aborts and cleans up", { skip: process.getuid?.() === 0 && "root can read anything" }, () =>
    refused("eacces", () => { const d = tree({ "ok.txt": "1", "secret-ish.txt": "2" }); chmodSync(join(d, "secret-ish.txt"), 0); return d; }, /EACCES|permission/i));
  it("refuses a tree above PROTON_DRIVE_UPLOAD_MAX_BYTES", () =>
    refused("bytes", () => tree({ "big.bin": "0123456789" }), /PROTON_DRIVE_UPLOAD_MAX_BYTES/, { PROTON_DRIVE_UPLOAD_MAX_BYTES: "5" }));

  it("photos_upload snapshots each path under its own holder", async () => {
    const d1 = tree({ "one.jpg": "1" });
    const d2 = tree({ "two.jpg": "2" });
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const r = await c.call("photos_upload", { localPaths: [join(d1, "one.jpg"), join(d2, "two.jpg")] });
      assert.equal(r.isError, false, r.text);
      const argv = nonVersionCalls(sb.argvLog)[0];
      const paths = argv.filter((a) => a.includes("pdmcp-upload-"));
      assert.equal(paths.length, 2);
      assert.deepEqual(paths.map((p) => basename(p)), ["one.jpg", "two.jpg"]);
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("snapshot integrity: approval, copy and spawn (fault injection)", () => {
  let base;
  let savedTmp;
  before(() => { base = mkdtempSync(join(tmpdir(), "upfault-")); savedTmp = process.env.TMPDIR; process.env.TMPDIR = base; });
  after(() => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; rmSync(base, { recursive: true, force: true }); });
  const mk = () => {
    const d = mkdtempSync(join(base, "t-"));
    mkdirSync(join(d, "p", "sub"), { recursive: true });
    writeFileSync(join(d, "p", "a.txt"), "alpha");
    writeFileSync(join(d, "p", "sub", "b.txt"), "beta");
    return join(d, "p");
  };
  const attempt = async (root, opts = {}) => {
    let reached = false;
    try { await withUploadSnapshot([root], async () => { reached = true; return 1; }, opts); }
    catch (e) { return { error: e, reached }; }
    return { error: null, reached };
  };
  const stagesLeft = () => readdirSync(base).filter((n) => n.startsWith("pdmcp-upload-")).length;

  it("clean tree: callback runs, staging removed", async () => {
    const root = mk();
    const before = stagesLeft();
    const r = await attempt(root, { approved: [precheckUpload(root)] });
    assert.equal(r.error, null);
    assert.equal(r.reached, true);
    assert.equal(stagesLeft(), before);
  });

  it("a file replaced by a symlink between scan and copy is refused", async () => {
    const root = mk();
    const outside = join(base, "outside.txt"); writeFileSync(outside, "SECRET");
    const r = await attempt(root, { hooks: { beforeCopy: (rel, src) => { if (rel === "a.txt") { unlinkSync(src); symlinkSync(outside, src); } } } });
    assert.ok(r.error, "must refuse");
    assert.equal(r.reached, false);
  });

  it("a file replaced by another regular file (new inode, same size) is refused", async () => {
    const root = mk();
    const r = await attempt(root, { hooks: { beforeCopy: (rel, src) => { if (rel === "a.txt") { unlinkSync(src); writeFileSync(src, "ALPHA"); } } } });
    assert.match(String(r.error), /changed after it was scanned/);
    assert.equal(r.reached, false);
  });

  it("an intermediate directory swapped for a symlink to look-alike content is refused (dev:ino mismatch)", async () => {
    const root = mk();
    const evil = join(base, "evil-" + Math.random().toString(36).slice(2)); mkdirSync(evil);
    writeFileSync(join(evil, "b.txt"), "beta");
    const r = await attempt(root, { hooks: { beforeCopy: (rel) => { if (rel === "sub/b.txt") { renameSync(join(root, "sub"), join(root, "sub.orig")); symlinkSync(evil, join(root, "sub")); } } } });
    assert.ok(r.error, "must refuse");
    assert.equal(r.reached, false);
  });

  it("an entry changed between approval and the upload is refused", async () => {
    const root = mk();
    const approved = [precheckUpload(root)];
    appendFileSync(join(root, "a.txt"), "!");
    const r = await attempt(root, { approved });
    assert.match(String(r.error), /changed after it was approved/);
    assert.equal(r.reached, false);
  });

  it("an entry added between approval and the upload is refused", async () => {
    const root = mk();
    const approved = [precheckUpload(root)];
    writeFileSync(join(root, "new.txt"), "x");
    const r = await attempt(root, { approved });
    assert.match(String(r.error), /changed after it was approved/);
  });

  for (const [label, tamper, match] of [
    ["content modified", (snap) => appendFileSync(join(snap, "a.txt"), "x"), /modified/],
    ["file replaced with same size", (snap) => { unlinkSync(join(snap, "a.txt")); writeFileSync(join(snap, "a.txt"), "ALPHA"); }, /modified/],
    ["entry added", (snap) => writeFileSync(join(snap, "extra.txt"), "x"), /modified/],
    ["entry removed", (snap) => unlinkSync(join(snap, "a.txt")), /modified/],
    ["file swapped for a symlink", (snap) => { unlinkSync(join(snap, "a.txt")); symlinkSync("/etc/hosts", join(snap, "a.txt")); }, /modified/],
  ]) {
    it(`the snapshot tampered before spawn (${label}) is refused`, async () => {
      const root = mk();
      const before = stagesLeft();
      const r = await attempt(root, { hooks: { beforeSpawn: ([snap]) => tamper(snap) } });
      assert.match(String(r.error), match);
      assert.equal(r.reached, false);
      assert.equal(stagesLeft(), before, "staging removed");
    });
  }
});
