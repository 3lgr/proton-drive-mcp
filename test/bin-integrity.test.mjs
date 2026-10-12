// S-01: binary pinning and doctor warnings.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, appendFileSync, existsSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeSandbox, startServer, nonVersionCalls, fakeEnv, FAKE_CLI, DIST_CLI } from "./helpers/mcp-client.mjs";

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pdbin-")); dirs.push(d); return d; };

describe("PROTON_DRIVE_BIN_SHA256", () => {
  it("matching pin: calls run (upper case and sha256: prefix accepted)", async () => {
    for (const pin of [sha(FAKE_CLI), sha(FAKE_CLI).toUpperCase(), "sha256:" + sha(FAKE_CLI)]) {
      const sb = makeSandbox();
      const c = await startServer("json", sb, { PROTON_DRIVE_BIN_SHA256: pin });
      try {
        const r = await c.call("drive_list", { path: "/my-files" });
        assert.equal(r.isError, false, r.text);
        assert.ok(nonVersionCalls(sb.argvLog).length > 0);
      } finally { await c.close(); sb.cleanup(); }
    }
  });

  it("mismatch: the binary is never executed", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN_SHA256: "0".repeat(64) });
    try {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /does not match PROTON_DRIVE_BIN_SHA256/);
      assert.deepEqual(readArgv(sb), [], "not even the startup probe may run the binary");
    } finally { await c.close(); sb.cleanup(); }
  });

  it("malformed pin fails closed instead of being ignored", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN_SHA256: "abc" });
    try {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /64 hexadecimal/);
    } finally { await c.close(); sb.cleanup(); }
  });

  const exeOf = (sb) => readFileSync(sb.argvLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).exe);

  it("with a pin, ONLY a private 0500 copy in a 0700 directory is executed, never the original", async () => {
    const d = tmp();
    const bin = join(d, "proton-drive");
    copyFileSync(FAKE_CLI, bin); chmodSync(bin, 0o755);
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: bin, PROTON_DRIVE_BIN_SHA256: sha(bin) });
    try {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      const exes = new Set(exeOf(sb));
      assert.equal(exes.size, 1);
      const [exe] = [...exes];
      assert.notEqual(exe, bin);
      assert.match(exe, /pdmcp-bin-[^/]+\/proton-drive$/);
      assert.equal(sha(exe), sha(bin));
      assert.equal(statSync(exe).mode & 0o777, 0o500);
      assert.equal(statSync(dirname(exe)).mode & 0o777, 0o700);
      globalThis.__lastExe = exe;
    } finally { await c.close(); sb.cleanup(); }
    assert.equal(existsSync(globalThis.__lastExe), false, "the private copy is removed on shutdown");
  });

  it("the original replaced after verification is irrelevant: the verified copy keeps running", async () => {
    const d = tmp();
    const bin = join(d, "proton-drive");
    copyFileSync(FAKE_CLI, bin); chmodSync(bin, 0o755);
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: bin, PROTON_DRIVE_BIN_SHA256: sha(bin) });
    try {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      writeFileSync(bin, "#!/bin/sh\necho pwned > " + join(d, "pwned") + "\n");
      chmodSync(bin, 0o755);
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      assert.equal(existsSync(join(d, "pwned")), false);
    } finally { await c.close(); sb.cleanup(); }
  });

  it("a symlink as PROTON_DRIVE_BIN: its target is what is hashed and copied; retargeting later changes nothing", async () => {
    const d = tmp();
    const real = join(d, "real-proton-drive");
    copyFileSync(FAKE_CLI, real); chmodSync(real, 0o755);
    const evil = join(d, "evil");
    writeFileSync(evil, "#!/bin/sh\ntouch " + join(d, "pwned") + "\n"); chmodSync(evil, 0o755);
    const link = join(d, "proton-drive");
    symlinkSync(real, link);
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: link, PROTON_DRIVE_BIN_SHA256: sha(real) });
    try {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      unlinkSync(link); symlinkSync(evil, link);
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      assert.equal(existsSync(join(d, "pwned")), false);
    } finally { await c.close(); sb.cleanup(); }
  });

  it("a symlink pointing at different bytes than the pin is refused and leaves no copy behind", async () => {
    const d = tmp();
    const evil = join(d, "evil");
    writeFileSync(evil, "#!/bin/sh\ntouch " + join(d, "pwned") + "\n"); chmodSync(evil, 0o755);
    const link = join(d, "proton-drive");
    symlinkSync(evil, link);
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: link, PROTON_DRIVE_BIN_SHA256: sha(FAKE_CLI) });
    try {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /does not match/);
      assert.equal(existsSync(join(d, "pwned")), false);
    } finally { await c.close(); sb.cleanup(); }
  });

  it("an adulterated copy is refused on the next call", async () => {
    const d = tmp();
    const bin = join(d, "proton-drive");
    copyFileSync(FAKE_CLI, bin); chmodSync(bin, 0o755);
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: bin, PROTON_DRIVE_BIN_SHA256: sha(bin) });
    try {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      const [exe] = new Set(exeOf(sb));
      chmodSync(dirname(exe), 0o700); chmodSync(exe, 0o700);
      appendFileSync(exe, "\n// adulterated\n");
      chmodSync(exe, 0o500);
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /modified|no longer matches/);
    } finally { await c.close(); sb.cleanup(); }
  });

  it("an unreadable binary fails closed", { skip: process.getuid?.() === 0 && "root reads anything" }, async () => {
    const d = tmp();
    const bin = join(d, "proton-drive");
    copyFileSync(FAKE_CLI, bin); chmodSync(bin, 0o755);
    const pin = sha(bin);
    chmodSync(bin, 0o000);
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: bin, PROTON_DRIVE_BIN_SHA256: pin });
    try {
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /could not be copied|cannot be read|refusing/);
    } finally { chmodSync(bin, 0o755); await c.close(); sb.cleanup(); }
  });

  it("whitespace around a pin is tolerated; an empty or blank variable means 'not pinned'; garbage is an error", async () => {
    for (const [pin, expectError] of [[`  ${sha(FAKE_CLI).toUpperCase()}\n`, false], ["", false], ["   ", false], ["xyz", true], ["sha256:" + "g".repeat(64), true], [sha(FAKE_CLI).slice(0, 63), true]]) {
      const sb = makeSandbox();
      const c = await startServer("json", sb, { PROTON_DRIVE_BIN_SHA256: pin });
      try {
        const r = await c.call("drive_list", { path: "/my-files" });
        assert.equal(r.isError, expectError, `${JSON.stringify(pin)}: ${r.text}`);
      } finally { await c.close(); sb.cleanup(); }
    }
  });
});

function readArgv(sb) {
  try { return readFileSync(sb.argvLog, "utf8").split("\n").filter(Boolean); } catch { return []; }
}

function doctor(env) {
  const sb = makeSandbox();
  const e = fakeEnv("json", sb, { CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope.json"), ...env });
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return new Promise((resolve) => execFile(process.execPath, [DIST_CLI, "doctor", "--json"], { env: e, timeout: 20_000 }, (err, stdout) => {
    sb.cleanup();
    resolve({ code: err ? 1 : 0, json: JSON.parse(stdout) });
  }));
}

describe("doctor: binary provenance", () => {
  const status = (j, id) => j.checks.find((c) => c.id === id);
  it("pinned and matching: cli-integrity ok", async () => {
    const { json } = await doctor({ PROTON_DRIVE_BIN_SHA256: sha(FAKE_CLI) });
    assert.equal(status(json, "cli-integrity").status, "ok");
  });
  it("not pinned: warns (does not fail)", async () => {
    const { code, json } = await doctor({});
    assert.equal(status(json, "cli-integrity").status, "warn");
    assert.equal(code, 0);
  });
  it("wrong pin: fails", async () => {
    const { code, json } = await doctor({ PROTON_DRIVE_BIN_SHA256: "f".repeat(64) });
    assert.equal(status(json, "cli-integrity").status, "fail");
    assert.equal(code, 1);
  });
  it("found through PATH: warns to use an absolute path", async () => {
    const d = tmp();
    const bin = join(d, "proton-drive");
    copyFileSync(FAKE_CLI, bin); chmodSync(bin, 0o755);
    const { json } = await doctor({ PROTON_DRIVE_BIN: undefined, PATH: `${d}:${process.env.PATH}` });
    assert.equal(status(json, "cli-from-path").status, "warn");
  });
  it("a group/world-writable directory or binary warns", async () => {
    const d = tmp();
    chmodSync(d, 0o777);
    const bin = join(d, "proton-drive");
    copyFileSync(FAKE_CLI, bin); chmodSync(bin, 0o755);
    const { json } = await doctor({ PROTON_DRIVE_BIN: bin });
    const w = json.checks.filter((c) => c.id === "cli-writable");
    assert.ok(w.length >= 1);
    assert.match(w[0].message, /writable by group or others/);
  });
});
