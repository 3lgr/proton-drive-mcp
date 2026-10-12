#!/usr/bin/env node
// Fake `proton-drive` binary for tests (use as PROTON_DRIVE_BIN).
//
// Env:
//   FAKE_ARGV_LOG     file that receives one JSON line per invocation: {argv, pid}
//   FAKE_MODE         json | shuffle | empty | undefined-literal | garbage | ansi-prefixed-json |
//                     fail-stderr | fail-stderr-echo | fail-stdout-crash | hang |
//                     big-stderr | auth-fail | ok-false-results | locked-then-json | transient-then-json | tree | download-hang
//                     download-hang: `filesystem info` prints a small text file node; `filesystem download` writes a partial file into the
//                     target dir, then hangs like `hang`. Everything else prints "[]".
//   FAKE_TREE         tree mode: path to a JSON file {"<folder path>": [list items]}; `filesystem list <path>` serves that entry
//                     (missing entry -> "Item not found" exit 1; a string entry is written to stderr, exit 1). Other commands print "[]".
//                     tree mode extras: tree["__info__"] = {"<path>": node} answers `filesystem info <path>` (else "[]");
//                     FAKE_DOWNLOAD_SWAP={path,to} replaces a directory by a symlink mid-transfer; FAKE_DOWNLOAD_FAIL=1 exits 1 after writing;
//                     entries may carry symlinkTo | hardlinkTo | fifo | mode.
//                     FAKE_DOWNLOAD_WRITE = JSON [{rel, content?, symlinkTo?}] is written under the destination folder by
//                     `filesystem download` / `photo download`, which then print a TransferSummary.
//   FAKE_COUNTER      locked-then-json: file holding the number of calls so far
//   FAKE_LOCKED_TIMES locked-then-json: how many calls fail with "database is locked" (default 2)
//   FAKE_TRANSIENT_KIND   transient-then-json: ratelimit | timeout | reset | retryafter | notfound (counter via FAKE_COUNTER)
//   FAKE_TRANSIENT_TIMES  transient-then-json: how many calls fail first (default 1)
//   FAKE_STDOUT       payload printed in json / ansi-prefixed-json mode (default "[]")
//   FAKE_SLEEP_MS     delay before answering in json mode
//   FAKE_PIDFILE      hang mode appends {role,pid,argv0} lines (child + grandchild)
//   FAKE_CLI_VERSION  version text override for `version` (default: CLI 0.8.0 / SDK 0.21.0 text; set verbatim, e.g. "garbage")
//   FAKE_HANG_VERSION 1 = `version` obeys FAKE_MODE (hang); otherwise it always prints version text
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "json";
const isVersion = argv[0] === "version";

if (process.env.FAKE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify({ argv, pid: process.pid, exe: process.argv[1] }) + "\n");
}

function hang() {
  if (process.env.FAKE_PIDFILE) {
    appendFileSync(process.env.FAKE_PIDFILE, JSON.stringify({ role: "child", pid: process.pid, argv0: argv[0] }) + "\n");
  }
  // Grandchild: ignores SIGTERM, stays in this process group.
  const gc = spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 1; done'], { stdio: "ignore" });
  if (process.env.FAKE_PIDFILE) {
    appendFileSync(process.env.FAKE_PIDFILE, JSON.stringify({ role: "grandchild", pid: gc.pid, argv0: argv[0] }) + "\n");
  }
  process.on("SIGTERM", () => { /* ignore, like a stubborn CLI */ });
  setInterval(() => {}, 1000);
}

if (isVersion && process.env.FAKE_HANG_VERSION !== "1") {
  process.stdout.write(process.env.FAKE_CLI_VERSION ?? "Proton Drive CLI cli-drive@0.8.0+abc\nProton Drive SDK js@0.21.0+abc\n");
  process.exit(0);
}

const payload = process.env.FAKE_STDOUT ?? "[]";

switch (mode) {
  case "json": {
    const ms = Number(process.env.FAKE_SLEEP_MS ?? 0);
    setTimeout(() => { process.stdout.write(payload + "\n"); process.exit(0); }, ms);
    break;
  }
  case "shuffle": {
    // Same items, different random order on every call (like the real CLI).
    const arr = JSON.parse(payload);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    process.stdout.write(JSON.stringify(arr) + "\n");
    process.exit(0);
    break;
  }
  case "empty":
    process.exit(0);
    break;
  case "undefined-literal":
    process.stdout.write("undefined\n");
    process.exit(0);
    break;
  case "garbage":
    process.stdout.write("this is not json {{{ at all\n");
    process.exit(0);
    break;
  case "ansi-prefixed-json":
    process.stdout.write("\x1b[32mLoading session...\x1b[0m\n\x1b[2K\r" + payload + "\n");
    process.exit(0);
    break;
  case "fail-stderr":
    process.stderr.write("Error: quota exceeded for this account\n    at Object.run (file:///x/y.js:1:1)\n");
    process.exit(2);
    break;
  case "fail-stderr-echo":
    process.stderr.write(`usage error while running: ${argv.join(" ")}\n`);
    process.exit(2);
    break;
  case "fail-stdout-crash":
    process.stderr.write("=====\n");
    process.stdout.write("ENOENT: no such file or directory, open '/nowhere/file.bin'");
    process.exit(1);
    break;
  case "download-hang":
    if (argv[0] === "filesystem" && argv[1] === "info") {
      process.stdout.write(JSON.stringify({ uid: "f1", type: "file", name: { ok: true, value: "a.txt" }, mediaType: "text/plain", activeRevision: { claimedSize: 10 } }) + "\n");
      process.exit(0);
    } else if (argv[0] === "filesystem" && argv[1] === "download") {
      writeFileSync(join(argv[3], "a.txt"), "partial");
      hang();
    } else {
      process.stdout.write("[]\n");
      process.exit(0);
    }
    break;
  case "hang":
    hang();
    break;
  case "big-stderr": {
    let s = "";
    for (let i = 0; i < 3000; i++) s += `line ${i} ${"x".repeat(1000)}\n`;
    process.stderr.write(s, () => process.exit(1));
    break;
  }
  case "auth-fail":
    process.stderr.write("You need to login first\n");
    process.exit(1);
    break;
  case "locked-then-json": {
    // First FAKE_LOCKED_TIMES calls fail like the real CLI's SQLite cache under
    // concurrent use; later calls succeed. FAKE_COUNTER holds the call count.
    const counter = process.env.FAKE_COUNTER;
    const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    if (counter) writeFileSync(counter, String(n + 1));
    if (n < Number(process.env.FAKE_LOCKED_TIMES ?? 2)) {
      process.stderr.write("SQLiteError: database is locked (SQLITE_BUSY_RECOVERY)\n");
      process.exit(1);
    }
    process.stdout.write(payload + "\n");
    process.exit(0);
    break;
  }
  case "transient-then-json": {
    const counter = process.env.FAKE_COUNTER;
    const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
    if (counter) writeFileSync(counter, String(n + 1));
    if (n < Number(process.env.FAKE_TRANSIENT_TIMES ?? 1)) {
      const msgs = {
        ratelimit: "Too many server requests, please try again later (429 Too Many Requests)",
        timeout: "Request timed out: GET https://drive-api.proton.me/core/v4/users",
        reset: "read ECONNRESET",
        retryafter: "429 Too Many Requests, Retry-After: 30",
        notfound: "Item not found: /nope",
      };
      process.stderr.write((msgs[process.env.FAKE_TRANSIENT_KIND ?? "ratelimit"]) + "\n");
      process.exit(1);
    }
    process.stdout.write(payload + "\n");
    process.exit(0);
    break;
  }
  case "tree": {
    if (argv[0] === "filesystem" && argv[1] === "list") {
      const tree = JSON.parse(readFileSync(process.env.FAKE_TREE, "utf8"));
      const entry = tree[argv[2]];
      const ms = Number(process.env.FAKE_SLEEP_MS ?? 0);
      setTimeout(() => {
        if (entry === undefined) { process.stderr.write(`Item not found: ${argv[2]}\n`); process.exit(1); }
        if (typeof entry === "string") { process.stderr.write(entry + "\n"); process.exit(1); }
        process.stdout.write(JSON.stringify(entry) + "\n");
        process.exit(0);
      }, ms);
    } else if (argv[0] === "filesystem" && argv[1] === "upload" && process.env.FAKE_UPLOAD_CAPTURE) {
      // Records what the "CLI" was handed: the path and, for a folder, every file's content and mtime.
      const cap = { path: argv[2], files: {} };
      const walk = (p, rel) => {
        const st = lstatSync(p);
        if (st.isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n), rel ? rel + "/" + n : n); }
        else cap.files[rel || basename(p)] = { content: readFileSync(p, "utf8"), mtimeMs: st.mtimeMs, mode: st.mode & 0o777 };
      };
      walk(argv[2], "");
      writeFileSync(process.env.FAKE_UPLOAD_CAPTURE, JSON.stringify(cap));
      process.stdout.write(JSON.stringify({ transferredItems: 1, transferredBytes: 1, skippedItems: 0, failedItems: 0 }) + "\n");
      process.exit(0);
    } else if (argv[0] === "filesystem" && argv[1] === "info") {
      const tree = JSON.parse(readFileSync(process.env.FAKE_TREE, "utf8"));
      const node = (tree.__info__ ?? {})[argv[2]];
      process.stdout.write(JSON.stringify(node ?? []) + "\n");
      process.exit(0);
    } else if ((argv[0] === "filesystem" && argv[1] === "download") || (argv[0] === "photo" && argv[1] === "download")) {
      const dest2 = argv[0] === "photo" ? argv[argv.indexOf("--conflict-strategy") - 1] : argv[3];
      for (const f of JSON.parse(process.env.FAKE_DOWNLOAD_WRITE ?? "[]")) {
        const full = join(dest2, f.rel);
        mkdirSync(dirname(full), { recursive: true });
        if (f.symlinkTo) symlinkSync(f.symlinkTo, full);
        else if (f.hardlinkTo) linkSync(f.hardlinkTo, full);
        else if (f.fifo) execFileSync("mkfifo", [full]);
        else writeFileSync(full, f.content ?? "x");
        if (f.mode !== undefined && !f.symlinkTo) chmodSync(full, f.mode);
      }
      // FAKE_DOWNLOAD_SWAP = {path, to}: the real destination is replaced by a symlink while the transfer runs (TOCTOU).
      if (process.env.FAKE_DOWNLOAD_SWAP) {
        const sw = JSON.parse(process.env.FAKE_DOWNLOAD_SWAP);
        renameSync(sw.path, sw.path + ".orig");
        symlinkSync(sw.to, sw.path);
      }
      if (process.env.FAKE_DOWNLOAD_FAIL === "1") { process.stderr.write("Error: connection lost mid-transfer\n"); process.exit(1); }
      process.stdout.write(JSON.stringify({ transferredItems: 1, transferredBytes: 1, skippedItems: 0, failedItems: 0 }) + "\n");
      process.exit(0);
    } else {
      process.stdout.write("[]\n");
      process.exit(0);
    }
    break;
  }
  case "ok-false-results":
    process.stdout.write(JSON.stringify([{ uid: "u1", ok: false, error: { name: "NodeWithSameNameExistsValidationError", code: 2500 } }]) + "\n");
    process.exit(0);
    break;
  default:
    process.stderr.write(`fake-cli: unknown FAKE_MODE ${mode}\n`);
    process.exit(3);
}
