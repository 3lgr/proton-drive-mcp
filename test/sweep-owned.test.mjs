// N-05 / N-07 (revised): the sweeper only ever looks inside the server's own private bases, and deletes a directory
// only when it is provably a scratch dir this server created: real directory, our uid, mode 0700, same device,
// valid marker (regular file, token + pid + time), old enough and with a dead creator pid. Removal never follows
// links. Everything else is skipped, never deleted.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync, chmodSync, readdirSync, statSync, utimesSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedTemp, sweepOwned, removeTreeSafe, ensurePrivateBase, MARKER_NAME } from "../dist/utils/privateTemp.js";
import { sweepStaleTempDirs, sweepStagingDirs } from "../dist/utils/tempSweep.js";

const HOUR = 3600_000;
const deadPid = (() => { const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]); return Number(r.stdout.toString()); })();
const marker = (o = {}) => JSON.stringify({ v: 1, token: "a".repeat(32), pid: deadPid, createdAt: Date.now() - 5 * HOUR, ...o });

let base, outside;
beforeEach(() => {
  const top = mkdtempSync(join(tmpdir(), "sweepown-"));
  base = join(top, "base");
  mkdirSync(base, { mode: 0o700 });
  outside = join(top, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "user data");
});
afterEach(() => { try { rmSync(join(base, ".."), { recursive: true, force: true }); } catch { /* ignore */ } });

/** An orphaned scratch dir as the server would have left it after a SIGKILL. */
function orphan(name, markerText = marker(), mode = 0o700) {
  const d = join(base, name);
  mkdirSync(d, { mode });
  chmodSync(d, mode);
  if (markerText !== null) writeFileSync(join(d, MARKER_NAME), markerText, { mode: 0o600 });
  mkdirSync(join(d, "w"));
  writeFileSync(join(d, "w", "partial.bin"), "x");
  return d;
}

describe("sweep deletes only provable, orphaned scratch directories", () => {
  it("removes a marked, old, orphaned directory (also a frozen read-only one)", () => {
    const d = orphan("pdmcp-stage-abcdef");
    chmodSync(join(d, "w"), 0o500);
    chmodSync(d, 0o700);
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), false);
  });
  it("a directory created by createOwnedTemp is kept while its creator (this process) is alive, however old", () => {
    const o = createOwnedTemp(base, "pdmcp-read-");
    sweepOwned(base, 0);
    assert.equal(existsSync(o.root), true);
  });
  it("a forged marker naming a LIVE pid is not deleted", () => {
    const d = orphan("pdmcp-read-abcdef", marker({ pid: process.ppid }));
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), true);
  });
  it("a young directory is not deleted", () => {
    const d = orphan("pdmcp-read-abcdef", marker({ createdAt: Date.now() - 1000 }));
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), true);
  });
  it("a planted directory WITHOUT a marker is not deleted", () => {
    const d = orphan("pdmcp-read-abcdef", null);
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), true);
  });
  for (const [label, text] of [["not JSON", "garbage"], ["wrong token shape", marker({ token: "../../x" })], ["wrong version", marker({ v: 2 })], ["pid as string", marker({ pid: "1" })],
    ["pid 0", marker({ pid: 0 })], ["oversized", marker({ pad: "x".repeat(600) })]]) {
    it(`a malformed marker (${label}) is not deleted`, () => {
      const d = orphan("pdmcp-dup-abcdef", text);
      sweepOwned(base, HOUR);
      assert.equal(existsSync(d), true);
    });
  }
  it("a symlink with the prefix pointing outside is not followed and its target survives", () => {
    writeFileSync(join(outside, MARKER_NAME), marker());
    symlinkSync(outside, join(base, "pdmcp-stage-abcdef"));
    sweepOwned(base, HOUR);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.equal(existsSync(join(base, "pdmcp-stage-abcdef")), true, "the link itself is left alone too");
  });
  it("a symlinked marker is not accepted", () => {
    const d = orphan("pdmcp-stage-abcdef", null);
    writeFileSync(join(outside, "m.json"), marker());
    symlinkSync(join(outside, "m.json"), join(d, MARKER_NAME));
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), true);
  });
  it("a hard-linked marker is not accepted", () => {
    const d = orphan("pdmcp-stage-abcdef", null);
    writeFileSync(join(outside, "m.json"), marker());
    linkSync(join(outside, "m.json"), join(d, MARKER_NAME));
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), true);
  });
  it("a plain file with the prefix, and names outside the pattern (including odd ones), are untouched", () => {
    writeFileSync(join(base, "pdmcp-read-abcdef"), "x");
    for (const n of ["pdmcp-stage-..", "pdmcp-stage-ab cdef", "pdmcp-stage-abcdefgh", "pdmcp-bin-abcdef", ".pdmcp-stage-abcdef", "notes"]) {
      try { mkdirSync(join(base, n), { mode: 0o700 }); writeFileSync(join(base, n, MARKER_NAME), marker()); } catch { /* name not creatable here */ }
    }
    sweepOwned(base, HOUR);
    for (const n of readdirSync(base)) assert.ok(existsSync(join(base, n)), n);
    assert.ok(readdirSync(base).includes("pdmcp-read-abcdef"));
    assert.ok(readdirSync(base).includes("pdmcp-bin-abcdef"));
  });
  it("a directory that is not 0700 is not deleted", () => {
    const d = orphan("pdmcp-stage-abcdef", marker(), 0o755);
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), true);
  });
  it("a base that is a symlink, or not private, is not swept at all", () => {
    const real = orphan("pdmcp-stage-abcdef");
    const link = join(base, "..", "base-link");
    symlinkSync(base, link);
    sweepOwned(link, HOUR);
    assert.equal(existsSync(real), true);
    chmodSync(base, 0o755);
    sweepOwned(base, HOUR);
    assert.equal(existsSync(real), true);
  });
  it("inside an orphan, a symlink to a user folder is unlinked, never followed", () => {
    const d = orphan("pdmcp-stage-abcdef");
    symlinkSync(outside, join(d, "w", "link-to-user-folder"));
    sweepOwned(base, HOUR);
    assert.equal(existsSync(d), false);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
  });
  it("removeTreeSafe refuses a symlink root and a tree that is too deep", () => {
    symlinkSync(outside, join(base, "lnk"));
    assert.throws(() => removeTreeSafe(join(base, "lnk")));
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    let p = join(base, "deep");
    mkdirSync(p);
    for (let i = 0; i < 70; i++) { p = join(p, "d"); mkdirSync(p); }
    assert.throws(() => removeTreeSafe(join(base, "deep")), /too deep/);
    assert.equal(existsSync(join(base, "deep")), true, "nothing removed on abort of the top level");
  });
  it("ensurePrivateBase creates 0700, tightens a loose one, refuses a symlink", () => {
    const b = join(base, "..", "newbase");
    assert.equal(ensurePrivateBase(b), true);
    assert.equal(statSync(b).mode & 0o777, 0o700);
    chmodSync(b, 0o755);
    assert.equal(ensurePrivateBase(b), true);
    assert.equal(statSync(b).mode & 0o777, 0o700);
    const l = join(base, "..", "linkbase");
    symlinkSync(outside, l);
    assert.equal(ensurePrivateBase(l), false);
  });
});

describe("the public sweep entry points look only at the fixed bases", () => {
  it("sweepStaleTempDirs(<base>) sweeps that base; a user folder named like scratch is never reached", async () => {
    const d = orphan("pdmcp-stage-abcdef");
    // a user folder that merely looks like scratch, outside any private base
    const lookalike = join(outside, "pdmcp-stage-abcdef");
    mkdirSync(lookalike, { mode: 0o700 });
    writeFileSync(join(lookalike, MARKER_NAME), marker());
    await sweepStaleTempDirs(base, HOUR);
    assert.equal(existsSync(d), false);
    assert.equal(existsSync(lookalike), true);
  });
  it("sweepStagingDirs sweeps <root>/.pdmcp-private and never the root itself or the destination's parent", async () => {
    const root = join(base, "..", "root");
    mkdirSync(root, { mode: 0o700 });
    const priv = join(root, ".pdmcp-private");
    mkdirSync(priv, { mode: 0o700 });
    const mk = (parent, name) => { const p = join(parent, name); mkdirSync(p, { mode: 0o700 }); writeFileSync(join(p, MARKER_NAME), marker()); return p; };
    const inPriv = mk(priv, "pdmcp-stage-abcdef");
    const inRoot = mk(root, "pdmcp-stage-abcdef");        // looks like scratch but sits in the user's root
    const inParent = mk(join(root, ".."), "pdmcp-stage-abcdef");
    const prev = process.env.PROTON_DRIVE_LOCAL_ROOT;
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    try { await sweepStagingDirs(HOUR); } finally { if (prev === undefined) delete process.env.PROTON_DRIVE_LOCAL_ROOT; else process.env.PROTON_DRIVE_LOCAL_ROOT = prev; }
    assert.equal(existsSync(inPriv), false);
    assert.equal(existsSync(inRoot), true);
    assert.equal(existsSync(inParent), true);
  });
});
