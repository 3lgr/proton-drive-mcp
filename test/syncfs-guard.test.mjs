import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, delimiter, dirname } from "node:path";

import {
  resolveSyncPath,
  readSyncFile,
} from "../dist/utils/syncfs.js";
import { assertLocalPathAllowed } from "../dist/utils/localguard.js";

describe("syncfs hardening", () => {
  let base, root, outside;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "syncguard-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "TOPSECRET");
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "ok.txt"), "fine");
    await symlink(outside, join(root, "escape-dir"));
    await symlink(join(outside, "secret.txt"), join(root, "escape-file.txt"));
    await symlink(join(root, "real"), join(root, "inner-dir"));
    await symlink(join(root, "real", "ok.txt"), join(root, "inner-file.txt"));
    await symlink(join(base, "does-not-exist"), join(root, "dangling"));
  });
  after(() => rm(base, { recursive: true, force: true }));

  it("read through escaping dir symlink is rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/escape-dir/secret.txt"), /outside sync root/);
  });

  it("read of escaping file symlink is rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/escape-file.txt"), /outside sync root/);
  });

  it("read of dangling symlink is rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/dangling"), /outside sync root/);
  });

  it("in-root symlinked directory that stays inside works for read", async () => {
    assert.equal(await readSyncFile(root, "/inner-dir/ok.txt"), "fine");
    assert.equal(await readSyncFile(root, "/inner-file.txt"), "fine");
  });

  it("sync root that is itself a symlink works", async () => {
    const linkRoot = join(base, "root-link");
    await symlink(root, linkRoot);
    assert.equal(await readSyncFile(linkRoot, "/real/ok.txt"), "fine");
    await assert.rejects(() => readSyncFile(linkRoot, "/escape-dir/secret.txt"), /outside sync root/);
  });

  it("lexical traversal is still rejected", async () => {
    await assert.rejects(() => readSyncFile(root, "/../outside/secret.txt"), /outside sync root/);
  });

  it("root '/' edge: resolveSyncPath does not reject valid or traversal-to-root paths", () => {
    assert.equal(resolveSyncPath("/", "/a/b"), "/a/b");
    assert.equal(resolveSyncPath("/", "/../a"), "/a");
    assert.equal(resolveSyncPath("/", "/"), "/");
  });

  it("sibling with shared prefix is not treated as inside", () => {
    assert.throws(() => resolveSyncPath("/tmp/sync", "/../sync-evil/x"), /outside sync root/);
  });

  it("read cap: 1MB ok, above 1MB rejected", async () => {
    await writeFile(join(root, "big-ok.txt"), "a".repeat(1024 * 1024));
    assert.equal((await readSyncFile(root, "/big-ok.txt")).length, 1024 * 1024);
    await writeFile(join(root, "big.txt"), "a".repeat(1024 * 1024 + 1));
    await assert.rejects(() => readSyncFile(root, "/big.txt"), /too large.*limit 1 MB/);
  });

  it("binary file still rejected", async () => {
    await writeFile(join(root, "b.bin"), Buffer.from([1, 0, 2]));
    await assert.rejects(() => readSyncFile(root, "/b.bin"), /binary file/);
  });

  it("reading a directory fails cleanly", async () => {
    await assert.rejects(() => readSyncFile(root, "/real"), /regular file|EISDIR/);
  });

});

describe("assertLocalPathAllowed", () => {
  const saved = {};
  const KEYS = ["PROTON_DRIVE_LOCAL_ROOT", "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS"];
  let base;

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "localguard-"));
  });
  after(() => rm(base, { recursive: true, force: true }));
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const home = homedir();
  const denied = [
    ".ssh/id_x",
    ".ssh",
    ".aws/credentials",
    ".gnupg/pubring.kbx",
    ".kube/config",
    ".docker/config.json",
    ".npmrc",
    ".netrc",
    ".pgpass",
    ".config/gcloud/credentials.db",
    ".claude/settings.json",
    ".claude.json",
    "Library/Keychains/login.keychain-db",
    "Library/Application Support/Claude/config.json",
  ];
  for (const rel of denied) {
    it(`denies ~/${rel}`, () => {
      assert.throws(() => assertLocalPathAllowed(join(home, rel)), /protected location|secret file/);
    });
  }

  for (const p of ["/etc/passwd", "/private/etc/hosts", "/var/root/x", "/etc"]) {
    it(`denies ${p}`, () => {
      assert.throws(() => assertLocalPathAllowed(p), /protected location/);
    });
  }

  for (const name of [
    ".env", ".env.local", ".env.production", "id_rsa", "id_rsa.pub", "id_ed25519",
    "cert.pem", "a.p12", "b.pfx", "login.keychain-db", "x.keychain",
  ]) {
    it(`denies basename ${name} anywhere`, () => {
      assert.throws(() => assertLocalPathAllowed(join(base, name)), /secret file/);
    });
  }

  it("allows normal files, including similar-looking names", () => {
    assertLocalPathAllowed(join(base, "report.pdf"));
    assertLocalPathAllowed(join(base, "environment.txt"));
    assertLocalPathAllowed(join(base, ".envrc-not"));
    assertLocalPathAllowed(join(home, ".sshfoo", "x"));
    assertLocalPathAllowed(join(home, "Documents", "a.txt"));
  });

  it("allows a nonexistent destination in a nonexistent dir", () => {
    assertLocalPathAllowed(join(base, "not", "yet", "there", "download.bin"));
  });

  it("rejects symlink pointing to a denied dir (existing target)", async () => {
    const link = join(base, "sshlink");
    await symlink(join(home, ".ssh"), link).catch(() => {});
    assert.throws(() => assertLocalPathAllowed(join(link, "id_foo")), /protected location|secret file/);
  });

  it("rejects symlink to a denied dir even when the destination file does not exist", async () => {
    const link = join(base, "etclink");
    await symlink("/etc", link);
    assert.throws(() => assertLocalPathAllowed(join(link, "newfile")), /protected location/);
  });

  it("rejects dangling symlink whose target is under a denied dir", async () => {
    const link = join(base, "dangling-ssh");
    await symlink(join(home, ".ssh", "no-such-key-file"), link);
    assert.throws(() => assertLocalPathAllowed(link), /protected location|secret file/);
  });

  it("rejects symlink to a .env file", async () => {
    const target = join(base, "real.env-holder");
    await writeFile(target, "x");
    const envTarget = join(base, ".env");
    await writeFile(envTarget, "S=1");
    const link = join(base, "innocent.txt");
    await symlink(envTarget, link);
    assert.throws(() => assertLocalPathAllowed(link), /secret file/);
  });

  it("PROTON_DRIVE_LOCAL_ROOT restricts to listed roots", async () => {
    const a = join(base, "rootA");
    const b = join(base, "rootB");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    process.env.PROTON_DRIVE_LOCAL_ROOT = [a, b].join(delimiter);
    assertLocalPathAllowed(join(a, "x.txt"));
    assertLocalPathAllowed(join(b, "deep", "y.txt"));
    assertLocalPathAllowed(a);
    assert.throws(() => assertLocalPathAllowed(join(base, "other.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assert.throws(() => assertLocalPathAllowed(join(a, "..", "other.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assert.throws(() => assertLocalPathAllowed(join(base, "rootA-evil", "x")), /outside PROTON_DRIVE_LOCAL_ROOT/);
  });

  it("PROTON_DRIVE_LOCAL_ROOT: symlink inside root pointing out is rejected", async () => {
    const a = join(base, "rootC");
    await mkdir(a, { recursive: true });
    await symlink(tmpdir(), join(a, "out"));
    process.env.PROTON_DRIVE_LOCAL_ROOT = a;
    assert.throws(() => assertLocalPathAllowed(join(a, "out", "f")), /outside PROTON_DRIVE_LOCAL_ROOT/);
  });

  it("PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 disables the denylist", () => {
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    assertLocalPathAllowed(join(home, ".ssh", "id_rsa"));
    assertLocalPathAllowed("/etc/hosts");
    assertLocalPathAllowed(join(base, ".env"));
  });

  it("scan mode rejects directories that CONTAIN protected locations; destinations are unaffected", async () => {
    for (const p of ["/", dirname(home), home]) {
      assert.throws(() => assertLocalPathAllowed(p, { scan: true }), /contains protected locations.*pick a subfolder/);
      assertLocalPathAllowed(p); // write destination (download folder): still allowed
    }
    const fakeHome = join(base, "fakehome");
    await mkdir(join(fakeHome, ".ssh"), { recursive: true });
    await mkdir(join(fakeHome, "Documents"), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      assert.throws(() => assertLocalPathAllowed(fakeHome, { scan: true }), /contains protected locations/);
      assertLocalPathAllowed(join(fakeHome, "Documents"), { scan: true });
      assertLocalPathAllowed(join(fakeHome, "Documents", "a.txt"), { scan: true });
      process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
      assertLocalPathAllowed(fakeHome, { scan: true });
    } finally {
      process.env.HOME = savedHome;
    }
  });

  // F-03: realpath (JS) does not normalise case, so ~/.SSH escaped the denylist on case-insensitive volumes.
  const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
  for (const rel of [".SSH/id_x", ".Ssh", ".AWS/credentials", ".GnuPG/pubring.kbx", ".Config/GCloud/credentials.db", "LIBRARY/keychains/login.keychain-db", ".CLAUDE/settings.json", ".Claude.JSON"]) {
    it(`denies case variant ~/${rel} (nothing of that spelling exists on disk)`, { skip: !CASE_INSENSITIVE && "case-sensitive platform" }, () => {
      assert.throws(() => assertLocalPathAllowed(join(home, rel)), /protected location|secret file/);
    });
  }

  it("denies a case variant of /etc", { skip: !CASE_INSENSITIVE && "case-sensitive platform" }, () => {
    assert.throws(() => assertLocalPathAllowed("/ETC/passwd"), /protected location/);
    assert.throws(() => assertLocalPathAllowed("/Private/Etc/hosts"), /protected location/);
  });

  it("denies the case variant of a real, existing protected directory (scan and plain)", { skip: !CASE_INSENSITIVE && "case-sensitive platform" }, async () => {
    const fakeHome = join(base, "fakehome-case");
    await mkdir(join(fakeHome, ".ssh"), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      assert.throws(() => assertLocalPathAllowed(join(fakeHome, ".SSH", "authorized_keys")), /protected location/);
      assert.throws(() => assertLocalPathAllowed(join(fakeHome, ".sSh")), /protected location/);
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it("a case variant of the HOME prefix itself is still recognised", { skip: !CASE_INSENSITIVE && "case-sensitive platform" }, () => {
    assert.throws(() => assertLocalPathAllowed(join(home.toUpperCase(), ".ssh", "id_x")), /protected location/);
  });

  it("does not over-match: a sibling that merely shares a prefix stays allowed", () => {
    assertLocalPathAllowed(join(home, ".ssh-backup-notes", "a.txt"));
    assertLocalPathAllowed(join(home, ".awsome", "a.txt"));
  });

  it("opt-out does not disable an explicit LOCAL_ROOT", async () => {
    const a = join(base, "rootD");
    await mkdir(a, { recursive: true });
    process.env.PROTON_DRIVE_LOCAL_ROOT = a;
    process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
    assert.throws(() => assertLocalPathAllowed(join(home, ".ssh", "id_rsa")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assertLocalPathAllowed(join(a, "ok.txt"));
  });
});
