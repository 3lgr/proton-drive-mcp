// F-04 / F-05: wider denylist, name denylist stays on under PROTON_DRIVE_LOCAL_ROOT, recursive pre-scan on upload.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { assertLocalPathAllowed } from "../dist/utils/localguard.js";
import { assertUploadTreeClean } from "../dist/utils/uploadScan.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const KEYS = ["PROTON_DRIVE_LOCAL_ROOT", "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS"];
const saved = {};
let base;
before(() => { base = mkdtempSync(join(tmpdir(), "lgscan-")); });
after(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("wider denylist (F-04)", () => {
  const home = homedir();
  for (const rel of [
    ".git-credentials", ".config/gh/hosts.yml", ".azure/accessTokens.json", ".config/op/config", ".password-store/x.gpg", ".vault-token",
    ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".zsh_history", ".bash_history", ".mozilla/firefox/p/logins.json",
    ".config/google-chrome/Default/Cookies", "Library/Application Support/Google/Chrome/Default/Login Data", "Library/Application Support/Firefox/x",
    "Library/Safari/History.db", ".gem/credentials", ".oci/config", ".config/rclone/rclone.conf",
  ]) {
    it(`denies ~/${rel}`, () => assert.throws(() => assertLocalPathAllowed(join(home, rel)), /protected location|secret file/));
  }
  for (const name of ["id_ecdsa", "id_dsa", "id_ecdsa.pub", "server.key", "vault.kdbx", "old.kdb", "credentials.json", ".git-credentials", ".htpasswd", "app.jks", "putty.ppk", "terraform.tfstate"]) {
    it(`denies basename ${name} anywhere`, () => assert.throws(() => assertLocalPathAllowed(join(base, name)), /secret file/));
  }
  it("still allows look-alikes", () => {
    for (const n of ["keyboard.txt", "monkey.txt", "credentials-policy.pdf", "kdbx-notes.md", "id_rsa_notes_not.txt".replace("id_rsa", "idea")]) assertLocalPathAllowed(join(base, n));
  });
});

describe("name denylist under PROTON_DRIVE_LOCAL_ROOT (F-05)", () => {
  it("keeps refusing secret-looking names inside an allowed root", () => {
    const root = mkdtempSync(join(base, "root-"));
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    for (const n of [".env", ".env.production", "id_rsa", "x.pem", "a.p12", "server.key", "credentials.json"]) {
      assert.throws(() => assertLocalPathAllowed(join(root, n)), /secret file/, n);
    }
    assertLocalPathAllowed(join(root, "report.pdf"));
  });
  it("keeps the protected-location denylist when the root contains it (LOCAL_ROOT=$HOME)", () => {
    process.env.PROTON_DRIVE_LOCAL_ROOT = homedir();
    assert.throws(() => assertLocalPathAllowed(join(homedir(), ".ssh", "id_x")), /protected location|secret file/);
    assertLocalPathAllowed(join(homedir(), "Documents", "a.txt"));
  });
  it("PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 lifts the name denylist but not the root", () => {
    const root = mkdtempSync(join(base, "root-"));
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    assertLocalPathAllowed(join(root, ".env"));
    assert.throws(() => assertLocalPathAllowed(join(base, "elsewhere.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
  });
});

describe("recursive upload pre-scan (F-04)", () => {
  const mk = (files, links = {}) => {
    const d = mkdtempSync(join(base, "up-"));
    for (const [rel, c] of Object.entries(files)) { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), c); }
    for (const [rel, target] of Object.entries(links)) { mkdirSync(join(d, rel, ".."), { recursive: true }); symlinkSync(target, join(d, rel)); }
    return d;
  };
  it("accepts a clean tree and a single file", () => {
    assertUploadTreeClean(mk({ "a.txt": "x", "sub/b.txt": "y" }));
    const d = mk({ "f.txt": "x" });
    assertUploadTreeClean(join(d, "f.txt"));
  });
  it("refuses a nested .env, key or pem and names the offender", () => {
    for (const rel of ["sub/deep/.env", "keys/x.pem", "a/id_ed25519", "k.kdbx"]) {
      const d = mk({ "ok.txt": "1", [rel]: "secret" });
      assert.throws(() => assertUploadTreeClean(d), (e) => /secret|protected/.test(e.message) && e.message.includes(rel.split("/").pop()), rel);
    }
  });
  it("refuses any symlink in the tree", () => {
    const d = mk({ "ok.txt": "1" }, { "sub/link": "/etc/passwd" });
    assert.throws(() => assertUploadTreeClean(d), /symlink/);
  });
  it("refuses a tree that is too large to scan completely (fail closed)", () => {
    const d = mk({ "a.txt": "1" });
    assert.throws(() => assertUploadTreeClean(d, { maxEntries: 0 }), /too large|complete/);
  });
  it("applies under LOCAL_ROOT too, and is off with ALLOW_SENSITIVE_PATHS for names only", () => {
    const d = mk({ "ok.txt": "1", "x/.env": "S" });
    process.env.PROTON_DRIVE_LOCAL_ROOT = d;
    assert.throws(() => assertUploadTreeClean(d), /secret|protected/);
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    assertUploadTreeClean(d);
  });
  it("a symlink stays refused even with ALLOW_SENSITIVE_PATHS=1", () => {
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    const d = mk({ "ok.txt": "1" }, { "l": "/etc/hosts" });
    assert.throws(() => assertUploadTreeClean(d), /symlink/);
  });
});

describe("upload tools run the pre-scan before the CLI", () => {
  it("drive_upload and photos_upload refuse a folder holding a secret", async () => {
    const d = mkdtempSync(join(base, "tool-"));
    writeFileSync(join(d, "ok.txt"), "1");
    writeFileSync(join(d, ".env"), "TOKEN=1");
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const a = await c.call("drive_upload", { localPath: d, remotePath: "/my-files" });
      assert.equal(a.isError, true);
      assert.match(a.text, /\.env/);
      const b = await c.call("photos_upload", { localPaths: [d] });
      assert.equal(b.isError, true);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    } finally { await c.close(); sb.cleanup(); }
  });
});
