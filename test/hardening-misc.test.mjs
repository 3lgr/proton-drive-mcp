// F-10 minimal child environment, F-12/F-13 redaction, F-14 list caps, F-15 config temp file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv } from "../dist/utils/childEnv.js";
import { redact } from "../dist/utils/redact.js";
import { writeEntry } from "../dist/utils/claudeConfig.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

describe("buildChildEnv (F-10)", () => {
  it("keeps what the CLI needs and drops everything else", () => {
    const env = buildChildEnv({
      HOME: "/h", PATH: "/bin", USER: "u", LANG: "C", LC_ALL: "C", TMPDIR: "/t", XDG_CONFIG_HOME: "/c", HTTPS_PROXY: "p", no_proxy: "x",
      PROTON_DRIVE_X: "1", AWS_SECRET_ACCESS_KEY: "s", GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k", NODE_OPTIONS: "--require /evil.js", LD_PRELOAD: "/evil.so",
      DYLD_INSERT_LIBRARIES: "/evil.dylib",
    });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "PATH", "PROTON_DRIVE_X", "TMPDIR", "USER", "XDG_CONFIG_HOME", "no_proxy"]);
  });
  it("PROTON_DRIVE_PASS_ENV adds exact names and prefixes", () => {
    const env = buildChildEnv({ PROTON_DRIVE_PASS_ENV: "MY_CA, CORP_*", MY_CA: "1", CORP_A: "2", CORP: "3", OTHER: "4" });
    assert.equal(env.MY_CA, "1");
    assert.equal(env.CORP_A, "2");
    assert.equal(env.CORP, undefined);
    assert.equal(env.OTHER, undefined);
  });
  it("the real CLI process does not inherit the server's secrets", async () => {
    const sb = makeSandbox();
    const dump = join(sb.dir, "env.json");
    const c = await startServer("json", sb, { FAKE_ENV_DUMP: dump, AWS_SECRET_ACCESS_KEY: "leak-me", GITHUB_TOKEN: "leak-me-too", NODE_OPTIONS: "" });
    try {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      const keys = JSON.parse(readFileSync(dump, "utf8"));
      assert.ok(!keys.includes("AWS_SECRET_ACCESS_KEY"));
      assert.ok(!keys.includes("GITHUB_TOKEN"));
      assert.ok(keys.includes("PROTON_DRIVE_MCP"));
      assert.ok(keys.includes("FAKE_MODE"));
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("redact (F-12/F-13)", () => {
  it("removes public links, link passwords and tokens", () => {
    assert.equal(redact("shared https://drive.proton.me/urls/ABCDEF#secretfragment ok"), "shared [public link redacted] ok");
    assert.equal(redact("run --password hunter2 now"), "run --password *** now");
    assert.equal(redact("--message=hello"), "--message=***");
    assert.equal(redact('password: "p w" x'), "password: *** x");
    assert.equal(redact("Authorization: Bearer abcdefghijkl"), "Authorization: ***");
    assert.equal(redact("Bearer abcdefghijklmnop"), "Bearer ***");
    assert.equal(redact("GET https://drive-api.proton.me/core/v4/users failed"), "GET https://drive-api.proton.me/core/v4/users failed");
  });
  it("a CLI failure that echoes a share link does not reach the client", async () => {
    const sb = makeSandbox();
    const c = await startServer("fail-stderr-echo", sb);
    try {
      const r = await c.call("drive_info", { path: "/my-files/https://drive.proton.me/urls/TOPSECRET#frag" });
      assert.equal(r.isError, true);
      assert.doesNotMatch(r.text, /TOPSECRET/);
      assert.doesNotMatch(c.stderr, /TOPSECRET/);
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("list caps (F-14)", () => {
  it("photoPaths and localPaths accept at most 200 entries and never reach the CLI above that", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const many = Array.from({ length: 201 }, (_, i) => `/photos/p${i}.jpg`);
      const a = await c.call("photos_download", { photoPaths: many, localFolder: join(tmpdir(), "pdmcp-cap") });
      assert.equal(a.isError, true);
      assert.match(a.text, /limit is 200/);
      const b = await c.call("photos_upload", { localPaths: many });
      assert.equal(b.isError, true);
      assert.match(b.text, /limit is 200/);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("claude config temp file (F-15)", () => {
  it("a pre-planted file/symlink at the old predictable name is never written through", () => {
    const d = mkdtempSync(join(tmpdir(), "pdcfg-"));
    try {
      const cfg = join(d, "claude_desktop_config.json");
      writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
      const victim = join(d, "victim.txt");
      writeFileSync(victim, "untouched");
      symlinkSync(victim, `${cfg}.tmp-${process.pid}`);
      writeEntry(cfg, { command: "node", args: ["x"], env: {} });
      assert.equal(readFileSync(victim, "utf8"), "untouched");
      assert.ok(JSON.parse(readFileSync(cfg, "utf8")).mcpServers["proton-drive-mcp"]);
      assert.deepEqual(readdirSync(d).filter((n) => n.includes(".tmp-") && !n.endsWith(`.tmp-${process.pid}`)), [], "no temp file left behind");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
