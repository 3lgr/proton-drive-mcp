// F-04 / F-05: wider denylist, name denylist stays on under PROTON_DRIVE_LOCAL_ROOT, recursive pre-scan on upload.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { assertLocalPathAllowed } from "../dist/utils/localguard.js";

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

