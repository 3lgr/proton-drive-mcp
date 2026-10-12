// N-05: the download staging directory is a marked private scratch dir under a base the server owns, never
// beside the destination (for a destination that is the root itself, "beside" would be its parent, e.g. $HOME).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const made = [];
const fresh = () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "stageroot-")));
  made.push(parent);
  const root = join(parent, "root");
  mkdirSync(root, { mode: 0o700 });
  return { parent, root };
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function download(env, localPath, parent) {
  const tree = join(parent, "tree.json");
  writeFileSync(tree, JSON.stringify({ __info__: { "/my-files/a.txt": { uid: "u1", type: "file", name: { ok: true, value: "a.txt" }, activeRevision: { claimedSize: 1 } } } }));
  const sb = makeSandbox();
  const c = await startServer("tree", sb, { FAKE_TREE: tree, FAKE_DOWNLOAD_WRITE: JSON.stringify([{ rel: "a.txt", content: "hi" }]), ...env });
  try {
    const r = await c.call("drive_download", { remotePath: "/my-files/a.txt", localPath });
    const argv = nonVersionCalls(sb.argvLog).find((a) => a[1] === "download");
    return { r, stage: argv[3] };
  } finally { await c.close(); sb.cleanup(); }
}

describe("N-05 staging is private and never beside the destination", () => {
  it("destination == the allowed root: the stage is <root>/.pdmcp-private/pdmcp-stage-*/w, nothing is created beside the root", async () => {
    const { parent, root } = fresh();
    const { r, stage } = await download({ PROTON_DRIVE_LOCAL_ROOT: root }, root, parent);
    assert.notEqual(r.isError, true, r.text);
    assert.equal(basename(stage), "w");
    assert.match(basename(dirname(stage)), /^pdmcp-stage-/);
    assert.equal(dirname(dirname(stage)), join(root, ".pdmcp-private"));
    assert.equal(statSync(join(root, ".pdmcp-private")).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(parent).sort(), ["root", "tree.json"], "nothing beside the root");
    assert.equal(existsSync(dirname(stage)), false, "scratch dir removed");
    assert.equal(existsSync(join(root, "a.txt")), true);
  });
  it("destination under a root: still inside that root's private folder, not next to the destination", async () => {
    const { parent, root } = fresh();
    const dest = join(root, "sub", "deeper");
    const { r, stage } = await download({ PROTON_DRIVE_LOCAL_ROOT: root }, dest, parent);
    assert.notEqual(r.isError, true, r.text);
    assert.equal(dirname(dirname(stage)), join(root, ".pdmcp-private"));
    assert.deepEqual(readdirSync(join(root, "sub")), ["deeper"]);
  });
  it("without an allowlist: the server's private temp base, still not beside the destination", async () => {
    const { parent } = fresh();
    const tmp = mkdtempSync(join(realpathSync(tmpdir()), "stagetmp-"));
    made.push(tmp);
    const dest = join(parent, "dest");
    const { r, stage } = await download({ TMPDIR: tmp }, dest, parent);
    assert.notEqual(r.isError, true, r.text);
    assert.equal(dirname(dirname(stage)), join(realpathSync(tmp), `pdmcp-private-${process.getuid()}`));
    assert.deepEqual(readdirSync(parent).sort(), ["dest", "root", "tree.json"]);
  });
});
