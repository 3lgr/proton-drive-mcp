// N-05 (revised): scratch space has no fixed, shared, predictable location. Each process makes its own random
// 0700 directory under the OS temp dir (or, if that is unusable, under an allowed root); per-operation dirs live
// inside it; nothing is ever created beside the destination; the byte/entry ceiling is enforced WHILE the CLI writes;
// every exit path removes what the operation created.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, realpathSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { scratchDirs } from "./helpers/scratch.mjs";

const made = [];
const fresh = () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "stageroot-")));
  made.push(parent);
  const root = join(parent, "root");
  mkdirSync(root, { mode: 0o700 });
  const tmp = join(parent, "tmp");
  mkdirSync(tmp, { mode: 0o700 });
  return { parent, root, tmp };
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const FILE_NODE = { uid: "u1", type: "file", name: { ok: true, value: "a.txt" }, activeRevision: { claimedSize: 1 } };

async function download({ parent, mode = "tree", env = {}, localPath, args = {} }) {
  const tree = join(parent, "tree.json");
  writeFileSync(tree, JSON.stringify({ __info__: { "/my-files/a.txt": FILE_NODE } }));
  const sb = makeSandbox();
  const c = await startServer(mode, sb, { FAKE_TREE: tree, FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "a.txt", content: "hi" }]), ...env });
  try {
    const t0 = Date.now();
    const r = await c.call("drive_download", { remotePath: "/my-files/a.txt", localPath, ...args }, { timeout: 30_000 });
    const argv = nonVersionCalls(sb.argvLog).find((a) => a[1] === "download");
    return { r, stage: argv?.[3], ms: Date.now() - t0 };
  } finally { await c.close(); sb.cleanup(); }
}

describe("N-05 private, random, per-process scratch", () => {
  it("the stage is <tmp>/pdmcp-XXXXXX/pdmcp-stage-*/w (0700), never beside the destination, and is removed", async () => {
    const { parent, root, tmp } = fresh();
    const { r, stage } = await download({ parent, localPath: root, env: { PROTON_DRIVE_LOCAL_ROOT: root, TMPDIR: tmp } });
    assert.notEqual(r.isError, true, r.text);
    assert.equal(basename(stage), "w");
    assert.match(basename(dirname(stage)), /^pdmcp-stage-/);
    assert.match(basename(dirname(dirname(stage))), /^pdmcp-[A-Za-z0-9]{6}$/);
    assert.equal(dirname(dirname(dirname(stage))), tmp);
    assert.deepEqual(readdirSync(parent).sort(), ["root", "tmp", "tree.json"], "nothing beside the destination root");
    assert.deepEqual(scratchDirs(tmp, "pdmcp-stage-"), [], "operation dir removed");
    assert.equal(existsSync(join(root, "a.txt")), true);
    assert.deepEqual(readdirSync(tmp), [], "the process directory is removed at exit");
  });

  it("a predictable name pre-created by someone else (symlink or foreign directory) does not matter", async () => {
    const { parent, root, tmp } = fresh();
    const victim = join(parent, "victim");
    mkdirSync(victim);
    for (const name of [`pdmcp-private-${process.getuid()}`, "pdmcp-private", "pdmcp-stage-aaaaaa", "pdmcp-read-aaaaaa", "pdmcp-upload-aaaaaa"]) symlinkSync(victim, join(tmp, name));
    mkdirSync(join(tmp, "pdmcp-squat"), { mode: 0o777 });
    const { r, stage } = await download({ parent, localPath: root, env: { PROTON_DRIVE_LOCAL_ROOT: root, TMPDIR: tmp } });
    assert.notEqual(r.isError, true, r.text);
    assert.deepEqual(readdirSync(victim), [], "nothing was written through the planted links");
    assert.ok(!stage.includes("victim"));
    assert.ok(existsSync(join(tmp, "pdmcp-squat")), "someone else's directory is left alone");
    assert.equal(lstatSync(join(tmp, "pdmcp-private-" + process.getuid())).isSymbolicLink(), true);
  });

  it("a TMPDIR that cannot be used falls back to <allowed root>/.pdmcp-private-<random>", async () => {
    const { parent, root } = fresh();
    const { r, stage } = await download({ parent, localPath: join(root, "d"), env: { PROTON_DRIVE_LOCAL_ROOT: root, TMPDIR: join(parent, "does-not-exist") } });
    assert.notEqual(r.isError, true, r.text);
    assert.match(basename(dirname(dirname(stage))), /^\.pdmcp-private-[A-Za-z0-9]{6}$/);
    assert.equal(dirname(dirname(dirname(stage))), root);
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".pdmcp-private-")), [], "removed at exit");
  });

  it("with neither an OS temp dir nor an allowed root, it fails with a clear message and writes nothing", async () => {
    const { parent, root } = fresh();
    const dest = join(root, "d");
    // allowlist lifted (no root to fall back to) and TMPDIR unusable
    const { r } = await download({ parent, localPath: dest, env: { PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH: "1", PROTON_DRIVE_LOCAL_ROOT: "", TMPDIR: join(parent, "nope") } });
    assert.equal(r.isError, true);
    assert.match(r.text, /no usable private temporary directory/);
    assert.equal(existsSync(join(dest, "a.txt")), false);
  });
});

describe("N-05 the ceiling is enforced during the write", () => {
  it("a transfer that crosses PROTON_DRIVE_DOWNLOAD_MAX_BYTES is aborted while running and everything is removed", async () => {
    const { parent, root, tmp } = fresh();
    const { r, ms } = await download({
      parent, mode: "download-hang", localPath: join(root, "d"),
      env: { PROTON_DRIVE_LOCAL_ROOT: root, TMPDIR: tmp, PROTON_DRIVE_DOWNLOAD_MAX_BYTES: "50", FAKE_PARTIAL_BYTES: "5000" },
    });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /PROTON_DRIVE_DOWNLOAD_MAX_BYTES|stopped/);
    assert.ok(ms < 20_000, `aborted promptly (${ms} ms)`);
    assert.deepEqual(scratchDirs(tmp, "pdmcp-"), []);
    assert.equal(existsSync(join(root, "d", "a.txt")), false);
  });

  it("an error in the middle of the transfer leaves no scratch directory", async () => {
    const { parent, root, tmp } = fresh();
    const { r } = await download({ parent, localPath: join(root, "d"), env: { PROTON_DRIVE_LOCAL_ROOT: root, TMPDIR: tmp, FAKE_DOWNLOAD_FAIL: "1" } });
    assert.equal(r.isError, true, r.text);
    assert.deepEqual(scratchDirs(tmp, "pdmcp-"), []);
    assert.equal(existsSync(join(root, "d", "a.txt")), false);
  });
});
