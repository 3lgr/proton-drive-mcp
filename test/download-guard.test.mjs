// F-02: every entry a download will write is validated against the local policy, not just the destination folder.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { assertSafeEntryName } from "../dist/services/downloadGuard.js";

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

  it("allows a normal folder, creates the destination private (0700) and passes the same argv as before", async () => {
    const dest = join(base, "d5", "nested");
    const { r, calls } = await run({
      __info__: { "/my-files/proj": folderNode },
      "/my-files/proj": [item("a.txt"), item(".gitignore"), item("sub", "folder")],
      "/my-files/proj/sub": [item("b.txt")],
    }, "drive_download", { remotePath: "/my-files/proj", localPath: dest }, { FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "proj/a.txt" }, { rel: "proj/.gitignore" }, { rel: "proj/sub/b.txt" }]) });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(downloads(calls)[0].slice(0, 4), ["filesystem", "download", "/my-files/proj", dest]);
    assert.equal(statSync(dest).mode & 0o777, 0o700);
  });

  it("single file: one info call, no tree walk", async () => {
    const { r, calls } = await run({ __info__: { "/my-files/a.txt": fileNode("a.txt") } }, "drive_download", { remotePath: "/my-files/a.txt", localPath: join(base, "d6") });
    assert.equal(r.isError, false, r.text);
    assert.ok(!calls.some((a) => a[1] === "list"));
  });

  it("post-download scan removes a symlink the CLI left behind and fails the call", async () => {
    const dest = join(base, "d7");
    const { r } = await run({
      __info__: { "/my-files/proj": folderNode },
      "/my-files/proj": [item("a.txt")],
    }, "drive_download", { remotePath: "/my-files/proj", localPath: dest }, { FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "proj/a.txt" }, { rel: "proj/evil", symlinkTo: "/etc/passwd" }]) });
    assert.equal(r.isError, true);
    assert.match(r.text, /symlink/);
    assert.equal(existsSync(join(dest, "proj", "evil")), false);
    assert.equal(existsSync(join(dest, "proj", "a.txt")), true);
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
