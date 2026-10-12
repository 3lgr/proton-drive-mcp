// S-01: binary pinning and doctor warnings.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("a binary modified after the first successful check is re-hashed and refused", async () => {
    const d = tmp();
    const bin = join(d, "proton-drive");
    copyFileSync(FAKE_CLI, bin); chmodSync(bin, 0o755);
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_BIN: bin, PROTON_DRIVE_BIN_SHA256: sha(bin) });
    try {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      appendFileSync(bin, "\n// tampered\n");
      const later = new Date(Date.now() + 5000);
      utimesSync(bin, later, later);
      const r = await c.call("drive_list", { path: "/my-files" });
      assert.equal(r.isError, true);
      assert.match(r.text, /does not match/);
    } finally { await c.close(); sb.cleanup(); }
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
