// N-05: the download staging directory lives inside the allowed local root (private, 0700), never beside a
// destination that is the root itself (which would be $HOME), and the sweeper cleans it after a killed process.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, utimesSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";
import { sweepStagingDirs } from "../dist/utils/tempSweep.js";

const made = [];
const fresh = () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "stageroot-")));
  made.push(parent);
  const root = join(parent, "root");
  mkdirSync(root, { mode: 0o700 });
  return { parent, root };
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("N-05 staging inside the allowed root", () => {
  it("destination == the root: the stage is root/.pdmcp-staging/<private dir>, nothing is created beside the root", async () => {
    const { parent, root } = fresh();
    const tree = join(parent, "tree.json");
    writeFileSync(tree, JSON.stringify({ __info__: { "/my-files/a.txt": { uid: "u1", type: "file", name: { ok: true, value: "a.txt" }, activeRevision: { claimedSize: 1 } } } }));
    const sb = makeSandbox();
    const c = await startServer("tree", sb, {
      FAKE_TREE: tree, PROTON_DRIVE_LOCAL_ROOT: root,
      FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "a.txt", content: "hi" }]),
    });
    try {
      const r = await c.call("drive_download", { remotePath: "/my-files/a.txt", localPath: root });
      assert.equal(r.isError, false, r.text);
      const argv = nonVersionCalls(sb.argvLog).find((a) => a[1] === "download");
      const stage = argv[3];
      assert.equal(basename(dirname(stage)), ".pdmcp-staging");
      assert.equal(dirname(dirname(stage)), root);
      assert.equal(statSync(dirname(stage)).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(parent).sort(), ["root", "tree.json"], "nothing beside the root");
      assert.equal(existsSync(stage), false, "stage removed");
      assert.equal(existsSync(join(root, "a.txt")), true);
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("N-05 the sweeper covers the staging directory", () => {
  it("removes old stage dirs under <root>/.pdmcp-staging, keeps recent ones", async () => {
    const { root } = fresh();
    const staging = join(root, ".pdmcp-staging");
    mkdirSync(staging, { mode: 0o700 });
    const old = join(staging, "pdmcp-stage-old");
    const recent = join(staging, "pdmcp-stage-recent");
    mkdirSync(old); mkdirSync(recent);
    writeFileSync(join(old, "partial.bin"), "x");
    const t = new Date(Date.now() - 2 * 3600_000);
    utimesSync(old, t, t);
    const before = process.env.PROTON_DRIVE_LOCAL_ROOT;
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    try { await sweepStagingDirs(3600_000); } finally { if (before === undefined) delete process.env.PROTON_DRIVE_LOCAL_ROOT; else process.env.PROTON_DRIVE_LOCAL_ROOT = before; }
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
  });
});
