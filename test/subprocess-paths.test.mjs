// utils/subprocess.ts driven in-process against the fake CLI: output handling, error classification (no argv or
// secret leaks), timeouts, cancellation, process-tree cleanup, retry rules and the availability probe.
process.env.PROTON_DRIVE_RETRY_BASE_MS = "20"; // read at import time
import { describe, it, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_CLI, isAlive, waitFor } from "./helpers/mcp-client.mjs";
import {
  runDrive, runDriveRaw, checkCliAvailable, timeoutFor, stripAnsi, isAuthError, callContext, killAllChildren, trackChild,
} from "../dist/utils/subprocess.js";
import { resetBinaryStateForTests } from "../dist/utils/binaryIntegrity.js";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "../dist/utils/errors.js";

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pdsub-")); dirs.push(d); return d; };
after(() => { killAllChildren(); resetBinaryStateForTests(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });

const FAKE_VARS = ["FAKE_MODE", "FAKE_STDOUT", "FAKE_COUNTER", "FAKE_TRANSIENT_KIND", "FAKE_TRANSIENT_TIMES", "FAKE_PIDFILE", "FAKE_HANG_VERSION", "FAKE_ARGV_LOG", "FAKE_FLOOD_MB", "FAKE_CLI_VERSION", "PROTON_DRIVE_BIN_SHA256"];
beforeEach(() => {
  for (const k of FAKE_VARS) delete process.env[k];
  resetBinaryStateForTests();
  process.env.PROTON_DRIVE_BIN = FAKE_CLI;
  process.env.PROTON_DRIVE_PASS_ENV = "FAKE_*";
});
const mode = (m, extra = {}) => { process.env.FAKE_MODE = m; Object.assign(process.env, extra); };
const pidsIn = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const spin = (pred, ms = 5000) => waitFor(pred, ms, 10);

describe("pure helpers", () => {
  it("transfer commands get 30 minutes, everything else 60 seconds", () => {
    for (const c of ["upload", "download", "copy", "move"]) {
      assert.equal(timeoutFor(["filesystem", c]), 30 * 60_000, c);
      assert.equal(timeoutFor(["photo", c]), 30 * 60_000, c);
    }
    assert.equal(timeoutFor(["filesystem", "list"]), 60_000);
    assert.equal(timeoutFor(["album", "download"]), 60_000, "group not in the transfer set");
    assert.equal(timeoutFor([]), 60_000);
  });
  it("stripAnsi removes colour, cursor and erase sequences only", () => {
    assert.equal(stripAnsi("\x1b[32mok\x1b[0m\x1b[2K\rdone"), "ok\rdone");
    assert.equal(stripAnsi("plain [text]"), "plain [text]");
  });
  it("isAuthError matches the CLI's login phrases case-insensitively", () => {
    assert.ok(isAuthError("You need to login first"));
    assert.ok(isAuthError("Session EXPIRED"));
    assert.equal(isAuthError("Item not found"), false);
  });
});

describe("output handling", () => {
  it("parses JSON, treats empty and the literal 'undefined' as null", async () => {
    mode("json", { FAKE_STDOUT: '[{"a":1}]' });
    assert.deepEqual(await runDrive(["filesystem", "list", "/my-files"]), [{ a: 1 }]);
    mode("empty");
    assert.equal(await runDrive(["sharing", "status", "/x"]), null);
    mode("undefined-literal");
    assert.equal(await runDrive(["sharing", "status", "/x"]), null);
  });
  it("finds the JSON after ANSI/progress noise", async () => {
    mode("ansi-prefixed-json", { FAKE_STDOUT: '{"ok":true}' });
    assert.deepEqual(await runDrive(["filesystem", "info", "/x"]), { ok: true });
  });
  it("non-JSON output is a parse error that reports the size, not the text", async () => {
    mode("garbage");
    await assert.rejects(runDrive(["filesystem", "list", "/x"]), (e) => {
      assert.ok(e instanceof DriveParseError);
      assert.match(e.message, /\d+ bytes that are not JSON/);
      assert.doesNotMatch(e.message, /this is not json/);
      return true;
    });
  });
  it("runDriveRaw returns plain text and does not append --json", async () => {
    const log = join(tmp(), "argv.log");
    mode("json", { FAKE_ARGV_LOG: log });
    const text = await runDriveRaw(["version"]);
    assert.match(text, /Proton Drive CLI/);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8").split("\n")[0]).argv, ["version"]);
    mode("json", { FAKE_STDOUT: "[]" });
    await runDrive(["filesystem", "list", "/x"]);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)).argv, ["filesystem", "list", "/x", "--json"]);
  });
});

describe("failures are classified, not echoed", () => {
  it("auth failure becomes DriveNotAuthenticatedError", async () => {
    mode("auth-fail");
    await assert.rejects(runDrive(["filesystem", "list", "/x"]), DriveNotAuthenticatedError);
    await assert.rejects(runDriveRaw(["whoami"]), DriveNotAuthenticatedError);
  });
  it("a CLI that echoes its argv (including a secret flag) never leaks it", async () => {
    mode("fail-stderr-echo");
    await assert.rejects(runDrive(["sharing", "set-url", "/x", "--password", "hunter2-secret"]), (e) => {
      assert.ok(e instanceof DriveCliError);
      assert.doesNotMatch(e.message, /hunter2/);
      return true;
    });
  });
  it("crash text on stdout and ordinary stderr failures both surface as DriveCliError", async () => {
    mode("fail-stdout-crash");
    await assert.rejects(runDrive(["filesystem", "download", "/x", "/tmp"]), DriveCliError);
    mode("fail-stderr");
    await assert.rejects(runDrive(["filesystem", "mkdir", "/x"]), DriveCliError);
  });
  it("a missing binary is DriveCliNotFoundError", async () => {
    process.env.PROTON_DRIVE_BIN = "/nonexistent/proton-drive";
    await assert.rejects(runDrive(["filesystem", "list", "/x"]), DriveCliNotFoundError);
  });
  it("output beyond 50 MB kills the CLI and reports the buffer limit", async () => {
    mode("flood");
    await assert.rejects(runDrive(["filesystem", "list", "/x"]), /exceeded buffer limit/);
  });
});

describe("timeouts, cancellation and cleanup", () => {
  async function startHang(args, { pidfile = join(tmp(), "pids") } = {}) {
    mode("hang", { FAKE_PIDFILE: pidfile });
    const p = runDrive(args);
    p.catch(() => {});
    await spin(() => pidsIn(pidfile).length >= 2);
    return { p, pidfile };
  }
  it("a hung read is killed with its whole process group at the 60 s budget", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pidfile = join(tmp(), "pids");
      mode("hang", { FAKE_PIDFILE: pidfile });
      const p = runDrive(["filesystem", "list", "/x"]);
      p.catch(() => {});
      while (pidsIn(pidfile).length < 2) await new Promise((r) => setImmediate(r));
      mock.timers.tick(60_000);
      await assert.rejects(p, /timed out after 60s \[TIMEOUT\]/);
      mock.timers.reset();
      await spin(() => pidsIn(pidfile).every((x) => !isAlive(x.pid)));
    } finally { mock.timers.reset(); }
  });
  it("a transfer gets the 30 minute budget", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pidfile = join(tmp(), "pids");
      mode("hang", { FAKE_PIDFILE: pidfile });
      const p = runDrive(["filesystem", "download", "/x", "/tmp/y"]);
      p.catch(() => {});
      while (pidsIn(pidfile).length < 2) await new Promise((r) => setImmediate(r));
      mock.timers.tick(60_000);
      await new Promise((r) => setImmediate(r));
      assert.ok(pidsIn(pidfile).every((x) => isAlive(x.pid)), "still running after 60 s");
      mock.timers.tick(30 * 60_000);
      await assert.rejects(p, /timed out after 1800s/);
    } finally { mock.timers.reset(); }
  });
  it("an already-aborted signal never spawns", async () => {
    const log = join(tmp(), "argv.log");
    mode("json", { FAKE_ARGV_LOG: log });
    const ac = new AbortController(); ac.abort();
    await assert.rejects(callContext.run({ signal: ac.signal }, () => runDrive(["filesystem", "list", "/x"])), /Cancelled by client/);
    assert.equal(existsSync(log), false);
  });
  it("aborting mid-call kills the process tree and rejects as cancelled", async () => {
    const ac = new AbortController();
    const pidfile = join(tmp(), "pids");
    mode("hang", { FAKE_PIDFILE: pidfile });
    const p = callContext.run({ signal: ac.signal }, () => runDrive(["filesystem", "list", "/x"]));
    p.catch(() => {});
    await spin(() => pidsIn(pidfile).length >= 2);
    ac.abort();
    await assert.rejects(p, /Cancelled by client/);
    await spin(() => pidsIn(pidfile).every((x) => !isAlive(x.pid)));
  });
  it("killAllChildren (shutdown) ends in-flight calls and their grandchildren", async () => {
    const { p, pidfile } = await startHang(["filesystem", "list", "/x"]);
    killAllChildren();
    await assert.rejects(p, DriveCliError);
    await spin(() => pidsIn(pidfile).every((x) => !isAlive(x.pid)));
  });
  it("trackChild registers helper processes for shutdown and can forget them", async () => {
    const a = spawn("sleep", ["30"], { stdio: "ignore" });
    const b = spawn("sleep", ["30"], { stdio: "ignore" });
    const forgetB = trackChild(b);
    trackChild(a);
    forgetB();
    killAllChildren();
    await spin(() => !isAlive(a.pid));
    assert.ok(isAlive(b.pid), "a forgotten child is left alone");
    b.kill("SIGKILL");
  });
});

describe("retry rules", () => {
  const counter = () => join(tmp(), "count");
  const count = (f) => Number(readFileSync(f, "utf8"));
  it("a read-only call survives two transient failures (3 attempts)", async () => {
    const c = counter();
    mode("transient-then-json", { FAKE_COUNTER: c, FAKE_TRANSIENT_KIND: "ratelimit", FAKE_TRANSIENT_TIMES: "2", FAKE_STDOUT: "[1]" });
    assert.deepEqual(await runDrive(["filesystem", "list", "/x"]), [1]);
    assert.equal(count(c), 3);
  });
  it("gives up after 3 attempts and a mutation is never retried", async () => {
    const c = counter();
    mode("transient-then-json", { FAKE_COUNTER: c, FAKE_TRANSIENT_KIND: "reset", FAKE_TRANSIENT_TIMES: "9" });
    await assert.rejects(runDrive(["filesystem", "list", "/x"]));
    assert.equal(count(c), 3);
    const m = counter();
    mode("transient-then-json", { FAKE_COUNTER: m, FAKE_TRANSIENT_KIND: "ratelimit", FAKE_TRANSIENT_TIMES: "9" });
    await assert.rejects(runDrive(["filesystem", "mkdir", "/x"]));
    assert.equal(count(m), 1);
  });
  it("cancelling while waiting to retry stops at once", async () => {
    const c = counter();
    mode("transient-then-json", { FAKE_COUNTER: c, FAKE_TRANSIENT_KIND: "retryafter", FAKE_TRANSIENT_TIMES: "9" }); // Retry-After: 30 -> capped 5 s wait
    const ac = new AbortController();
    const t0 = Date.now();
    const p = callContext.run({ signal: ac.signal }, () => runDrive(["filesystem", "list", "/x"]));
    p.catch(() => {});
    await spin(() => existsSync(c));
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await assert.rejects(p, /Cancelled by client/);
    assert.ok(Date.now() - t0 < 4000, "did not sit out the Retry-After");
    assert.equal(count(c), 1);
  });
  it("not-found is not transient", async () => {
    const c = counter();
    mode("transient-then-json", { FAKE_COUNTER: c, FAKE_TRANSIENT_KIND: "notfound", FAKE_TRANSIENT_TIMES: "9" });
    await assert.rejects(runDrive(["filesystem", "list", "/x"]));
    assert.equal(count(c), 1);
  });
});

describe("checkCliAvailable", () => {
  it("present", async () => {
    assert.deepEqual(await checkCliAvailable(), { available: true });
  });
  it("missing binary: not_found", async () => {
    process.env.PROTON_DRIVE_BIN = "/nonexistent/proton-drive";
    assert.equal((await checkCliAvailable()).reason, "not_found");
  });
  it("present but not executable: not_executable", async () => {
    const f = join(tmp(), "proton-drive");
    writeFileSync(f, "#!/bin/sh\n"); chmodSync(f, 0o644);
    process.env.PROTON_DRIVE_BIN = f;
    assert.equal((await checkCliAvailable()).reason, "not_executable");
  });
  it("a pin that does not match is reported as an integrity refusal", async () => {
    process.env.PROTON_DRIVE_BIN_SHA256 = "e".repeat(64);
    const r = await checkCliAvailable();
    assert.equal(r.available, false);
    assert.equal(r.reason, "integrity");
    assert.match(r.detail, /does not match/);
  });
  it("a CLI that is slow to answer counts as available after 5 s (real errors surface on the first call)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pidfile = join(tmp(), "pids");
      mode("hang", { FAKE_PIDFILE: pidfile, FAKE_HANG_VERSION: "1" });
      const p = checkCliAvailable();
      while (pidsIn(pidfile).length < 2) await new Promise((r) => setImmediate(r));
      mock.timers.tick(5_000);
      assert.deepEqual(await p, { available: true });
      mock.timers.reset();
      await spin(() => pidsIn(pidfile).every((x) => !isAlive(x.pid)));
    } finally { mock.timers.reset(); }
  });
});
