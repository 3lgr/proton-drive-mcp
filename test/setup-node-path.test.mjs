// T4: setup-claude-desktop writes a stable absolute `node` (a PATH entry that resolves to the running binary),
// not the versioned Cellar path that breaks on `brew upgrade node`. Temp dirs and symlinks only.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, chmodSync as chmod2, copyFileSync, chmodSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, fakeEnv, DIST_CLI } from "./helpers/mcp-client.mjs";
import { stableNodePath, dirTooOpen, buildEntry, nodePathNote } from "../dist/utils/claudeConfig.js";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pdnode-")); dirs.push(d); return realpathSync(d); };

function setupDryRun(PATH) {
  const sb = makeSandbox();
  const env = fakeEnv("json", sb, { PATH, CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope", "c.json") });
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, "setup-claude-desktop", "--config", join(sb.dir, "c.json")], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      sb.cleanup();
      const m = stdout.match(/"command": "([^"]*)"/);
      resolve({ code: err ? 1 : 0, command: m?.[1], stdout, stderr });
    });
  });
}

describe("setup-claude-desktop: stable node path", () => {
  it("prefers a PATH entry whose realpath is the running node (symlink dir)", async () => {
    const d = tmp();
    symlinkSync(process.execPath, join(d, "node"));
    const r = await setupDryRun(`${d}:/usr/bin`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.command, join(d, "node"));
  });
  it("takes the first matching directory in PATH order", async () => {
    const a = tmp(), b = tmp();
    symlinkSync(process.execPath, join(a, "node"));
    symlinkSync(process.execPath, join(b, "node"));
    assert.equal((await setupDryRun(`${a}:${b}`)).command, join(a, "node"));
    assert.equal((await setupDryRun(`${b}:${a}`)).command, join(b, "node"));
  });
  it("ignores a different 'node' earlier in PATH (another install) and a non-executable one", async () => {
    const other = tmp(), plain = tmp(), good = tmp();
    writeFileSync(join(other, "node"), "#!/bin/sh\nexit 0\n"); chmodSync(join(other, "node"), 0o755); // not our binary
    writeFileSync(join(plain, "node"), "not executable");
    symlinkSync(process.execPath, join(good, "node"));
    assert.equal((await setupDryRun(`${other}:${plain}:${good}`)).command, join(good, "node"));
  });
  it("falls back to process.execPath when no PATH entry matches", async () => {
    const empty = tmp(), other = tmp();
    writeFileSync(join(other, "node"), "#!/bin/sh\n"); chmodSync(join(other, "node"), 0o755);
    assert.equal((await setupDryRun(`${empty}:${other}`)).command, process.execPath);
  });
  it("skips relative and empty PATH entries (they would depend on the cwd)", async () => {
    const d = tmp();
    mkdirSync(join(d, "rel"));
    symlinkSync(process.execPath, join(d, "rel", "node"));
    const r = await new Promise((resolve) => {
      const sb = makeSandbox();
      execFile(process.execPath, [DIST_CLI, "setup-claude-desktop", "--config", join(sb.dir, "c.json")], { cwd: d, env: fakeEnv("json", sb, { PATH: `rel::.` }), timeout: 20_000 }, (_e, stdout) => {
        sb.cleanup();
        resolve(stdout.match(/"command": "([^"]*)"/)?.[1]);
      });
    });
    assert.equal(r, process.execPath);
  });
  it("a dangling 'node' symlink does not break setup", async () => {
    const d = tmp();
    symlinkSync(join(d, "missing"), join(d, "node"));
    assert.equal((await setupDryRun(d)).command, process.execPath);
  });
  it("ignores a symlink whose realpath is a different executable", async () => {
    const d = tmp(), t = tmp();
    writeFileSync(join(t, "other-node"), "#!/bin/sh\n"); chmodSync(join(t, "other-node"), 0o755);
    symlinkSync(join(t, "other-node"), join(d, "node"));
    assert.equal((await setupDryRun(d)).command, process.execPath);
  });
  it("ignores a directory that group or others can write to (anyone could swap the link)", async () => {
    const d = tmp();
    symlinkSync(process.execPath, join(d, "node"));
    chmod2(d, 0o777);
    assert.equal((await setupDryRun(d)).command, process.execPath);
    chmod2(d, 0o755);
    assert.equal((await setupDryRun(d)).command, join(d, "node"));
  });
  it("dirTooOpen: the Homebrew layout (user:admin 0775 on macOS) is accepted, anything wider is not", () => {
    const me = 501;
    assert.equal(dirTooOpen({ mode: 0o40775, uid: me, gid: 80 }, me, "darwin"), false, "Homebrew /opt/homebrew/bin");
    assert.equal(dirTooOpen({ mode: 0o40755, uid: me, gid: 80 }, me, "darwin"), false, "not group-writable");
    assert.equal(dirTooOpen({ mode: 0o40775, uid: me, gid: 20 }, me, "darwin"), true, "group other than admin");
    assert.equal(dirTooOpen({ mode: 0o40775, uid: 0, gid: 80 }, me, "darwin"), true, "owned by someone else");
    assert.equal(dirTooOpen({ mode: 0o40775, uid: me, gid: 80 }, me, "linux"), true, "same bits on Linux are not trusted");
    assert.equal(dirTooOpen({ mode: 0o40777, uid: me, gid: 80 }, me, "darwin"), true, "world-writable");
    assert.equal(dirTooOpen({ mode: 0o40777, uid: me, gid: 80 }, me, "win32"), false, "modes mean nothing on Windows");
  });
  it("--exact-node writes the real execPath, and the note names the risk only for a group-writable link directory", () => {
    const d = tmp();
    const link = join(d, "node");
    assert.equal(buildEntry("/x/proton-drive", undefined, undefined, {}, true).command, process.execPath);
    chmodSync(d, 0o775);
    assert.match(nodePathNote(link, "/real/node") ?? "", /--exact-node/);
    chmodSync(d, 0o755);
    assert.equal(nodePathNote(link, "/real/node"), undefined, "a private directory needs no warning");
    assert.equal(nodePathNote("/real/node", "/real/node"), undefined, "the real path needs no warning");
  });
  it("does not reject the stable link because the real binary is group-writable (CI tool caches are)", () => {
    const d = tmp();
    const realDir = tmp();
    const fakeNode = join(realDir, "real-node");
    writeFileSync(fakeNode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeNode, 0o775); // group-writable, like /opt/hostedtoolcache on GitHub runners
    symlinkSync(fakeNode, join(d, "node"));
    chmodSync(d, 0o755);
    assert.equal(stableNodePath(fakeNode, d), join(d, "node"));
    chmodSync(d, 0o777); // the PATH directory is the trust surface: still refused
    assert.equal(stableNodePath(fakeNode, d), fakeNode);
  });
});
