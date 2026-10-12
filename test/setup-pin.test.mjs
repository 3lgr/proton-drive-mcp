// T3: `setup-claude-desktop --pin` and `doctor` reading the pin from the Claude Desktop ENTRY (temp files only).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, appendFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, fakeEnv, DIST_CLI, DIST_INDEX, FAKE_CLI } from "./helpers/mcp-client.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pdpin-")); dirs.push(d); return d; };
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** A distinct "binary": the fake CLI plus a trailing comment, so its hash differs from FAKE_CLI's. */
function fakeBinary(marker = "x") {
  const p = join(tmp(), "proton-drive");
  copyFileSync(FAKE_CLI, p);
  appendFileSync(p, `\n// ${marker}\n`);
  chmodSync(p, 0o755);
  return p;
}

function run(args, env = {}) {
  const sb = makeSandbox();
  const e = fakeEnv("json", sb, { CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope", "c.json"), ...env });
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { env: e, timeout: 20_000 }, (err, stdout, stderr) => {
      sb.cleanup();
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
const entryOf = (f) => JSON.parse(readFileSync(f, "utf8")).mcpServers["proton-drive-mcp"];

describe("setup-claude-desktop --pin", () => {
  it("dry run shows the hash and writes nothing", async () => {
    const f = join(tmp(), "c.json");
    const r = await run(["setup-claude-desktop", "--config", f, "--pin"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Dry run/);
    assert.ok(r.stdout.includes(sha(FAKE_CLI)));
    assert.match(r.stdout, /PROTON_DRIVE_BIN_SHA256/);
    assert.ok(!existsSync(f));
  });
  it("--write --pin stores PROTON_DRIVE_BIN and the sha256 of exactly that binary in the entry env", async () => {
    const bin = fakeBinary("pin-me");
    const f = join(tmp(), "c.json");
    const r = await run(["setup-claude-desktop", "--config", f, "--write", "--pin"], { PROTON_DRIVE_BIN: bin });
    assert.equal(r.code, 0, r.stderr);
    const env = entryOf(f).env;
    assert.equal(env.PROTON_DRIVE_BIN, bin);
    assert.equal(env.PROTON_DRIVE_BIN_SHA256, sha(bin));
    assert.notEqual(env.PROTON_DRIVE_BIN_SHA256, sha(FAKE_CLI));
    assert.match(env.PROTON_DRIVE_BIN_SHA256, /^[0-9a-f]{64}$/);
  });
  it("without --pin nothing changes, even when the process env carries a pin", async () => {
    const f = join(tmp(), "c.json");
    const r = await run(["setup-claude-desktop", "--config", f, "--write"], { PROTON_DRIVE_BIN_SHA256: sha(FAKE_CLI), PATH: tmp() });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(entryOf(f), { command: process.execPath, args: [DIST_INDEX], env: { PROTON_DRIVE_BIN: FAKE_CLI } });
  });
  it("re-running with --pin after the binary changed rewrites the pin (new backup)", async () => {
    const bin = fakeBinary("v1");
    const f = join(tmp(), "c.json");
    await run(["setup-claude-desktop", "--config", f, "--write", "--pin"], { PROTON_DRIVE_BIN: bin });
    const first = entryOf(f).env.PROTON_DRIVE_BIN_SHA256;
    appendFileSync(bin, "// v2\n");
    await run(["setup-claude-desktop", "--config", f, "--write", "--pin"], { PROTON_DRIVE_BIN: bin });
    assert.equal(entryOf(f).env.PROTON_DRIVE_BIN_SHA256, sha(bin));
    assert.notEqual(entryOf(f).env.PROTON_DRIVE_BIN_SHA256, first);
  });
  it("mentions --pin in --help", async () => {
    const r = await run(["--help"]);
    assert.match(r.stdout, /--pin/);
  });
});

describe("doctor reads the pin from the Claude Desktop entry", () => {
  const write = (bin, env) => {
    const f = join(tmp(), "c.json");
    writeFileSync(f, JSON.stringify({ mcpServers: { "proton-drive-mcp": { command: process.execPath, args: [DIST_INDEX], env: { PROTON_DRIVE_BIN: bin, ...env } } } }));
    return f;
  };
  const integrity = (r) => JSON.parse(r.stdout).checks.find((c) => c.id === "cli-integrity");
  const doctor = (f) => run(["doctor", "--json", "--config", f], { PROTON_DRIVE_BIN_SHA256: undefined });

  it("entry pin matching the entry's binary: ok, no 'not pinned' warning", async () => {
    const f = write(FAKE_CLI, { PROTON_DRIVE_BIN_SHA256: sha(FAKE_CLI) });
    const r = await doctor(f);
    assert.equal(integrity(r).status, "ok");
    assert.match(integrity(r).message, /entry/);
    assert.equal(r.code, 0);
  });
  it("entry pin that no longer matches (CLI updated): fail with the recompute hint", async () => {
    const f = write(FAKE_CLI, { PROTON_DRIVE_BIN_SHA256: "f".repeat(64) });
    const r = await doctor(f);
    assert.equal(integrity(r).status, "fail");
    assert.match(integrity(r).hint, /setup-claude-desktop --write --pin/);
    assert.equal(r.code, 1);
  });
  it("malformed entry pin: fail", async () => {
    const r = await doctor(write(FAKE_CLI, { PROTON_DRIVE_BIN_SHA256: "not-a-hash" }));
    assert.equal(integrity(r).status, "fail");
  });
  it("no pin anywhere: still the warn", async () => {
    const r = await doctor(write(FAKE_CLI, {}));
    assert.equal(integrity(r).status, "warn");
    assert.equal(r.code, 0);
  });
  it("hashes the entry's PROTON_DRIVE_BIN, not whatever the shell resolves", async () => {
    const other = fakeBinary("entry-bin");
    const f = write(other, { PROTON_DRIVE_BIN_SHA256: sha(other) });
    const r = await doctor(f);
    assert.equal(integrity(r).status, "ok");
  });
});
