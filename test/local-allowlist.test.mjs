// The local-path ALLOWLIST: default folder ~/ProtonDriveMCP, PROTON_DRIVE_LOCAL_ROOT, explicit opt-out.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalPathAllowed, resolveAllowedLocal, describeRoots } from "../dist/utils/localguard.js";
import { validateLocalPath } from "../dist/utils/validation.js";
import { makeSandbox, startServer, nonVersionCalls } from "./helpers/mcp-client.mjs";

const KEYS = ["PROTON_DRIVE_LOCAL_ROOT", "PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH", "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS", "HOME"];
const saved = {};
let base;
let fakeHome;
before(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "allowlist-"))); });
after(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  fakeHome = mkdtempSync(join(base, "home-"));
  process.env.HOME = fakeHome; // os.homedir() follows HOME on POSIX
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("default: one dedicated folder created by the server", () => {
  it("is created 0700 on first use, and only paths inside it are allowed", () => {
    const root = join(fakeHome, "ProtonDriveMCP");
    assert.equal(existsSync(root), false);
    assertLocalPathAllowed(join(root, "report.pdf"));
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.deepEqual(describeRoots().mode, "default");
    assertLocalPathAllowed(join(root, "sub", "deep", "x.txt"));
    assert.throws(() => assertLocalPathAllowed(join(fakeHome, "Documents", "a.txt")), /outside the default local folder/);
    assert.throws(() => assertLocalPathAllowed("/tmp/x"), /outside the default local folder/);
    assert.throws(() => assertLocalPathAllowed(fakeHome), /outside the default local folder/);
  });
  it("a symlinked default folder is refused", () => {
    const elsewhere = join(fakeHome, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(fakeHome, "ProtonDriveMCP"));
    assert.throws(() => assertLocalPathAllowed(join(fakeHome, "ProtonDriveMCP", "x")), /symlink/);
  });
  it("a symlink inside the folder that points outside is refused", () => {
    const root = join(fakeHome, "ProtonDriveMCP");
    mkdirSync(root, { mode: 0o700 });
    const outside = join(fakeHome, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "out"));
    assert.throws(() => assertLocalPathAllowed(join(root, "out", "x.txt")), /outside the default local folder/);
  });
  it("'..' and relative paths never get that far", () => {
    const root = join(fakeHome, "ProtonDriveMCP");
    assert.throws(() => validateLocalPath(`${root}/../x`), /'\.' or '\.\.'/);
    assert.throws(() => validateLocalPath("relative/x"), /absolute/);
  });
  it("resolveAllowedLocal returns the real path", () => {
    const root = join(fakeHome, "ProtonDriveMCP");
    mkdirSync(root, { mode: 0o700 });
    assert.equal(resolveAllowedLocal(join(root, "a.txt")), join(realpathSync(root), "a.txt"));
  });
});

describe("PROTON_DRIVE_LOCAL_ROOT", () => {
  const mkroot = (name = "work") => { const d = join(base, `${name}-${Math.random().toString(36).slice(2)}`); mkdirSync(d); return d; };
  it("replaces the default folder; outside, symlinks out and sibling look-alikes are refused", () => {
    const root = mkroot();
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    assertLocalPathAllowed(join(root, "ok.txt"));
    assert.throws(() => assertLocalPathAllowed(join(base, "other.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assert.throws(() => assertLocalPathAllowed(root + "-evil/x"), /outside PROTON_DRIVE_LOCAL_ROOT/);
    mkdirSync(join(base, "secret-target"), { recursive: true });
    symlinkSync(join(base, "secret-target"), join(root, "link"));
    assert.throws(() => assertLocalPathAllowed(join(root, "link", "f")), /outside PROTON_DRIVE_LOCAL_ROOT/);
    assert.equal(existsSync(join(fakeHome, "ProtonDriveMCP")), false, "the default folder is not created when a root is configured");
  });
  it("refuses a root that is the home folder, '/', does not exist, is a symlink or contains protected folders", () => {
    mkdirSync(join(fakeHome, ".ssh"));
    for (const [root, msg] of [[fakeHome, /home folder|protected location/], ["/", /home folder|protected location|"\/"/], [join(base, "nope"), /does not exist/]]) {
      process.env.PROTON_DRIVE_LOCAL_ROOT = root;
      assert.throws(() => assertLocalPathAllowed(join(root, "x")), msg, String(root));
    }
    const real = mkroot();
    const link = join(base, "rootlink-" + Math.random().toString(36).slice(2));
    symlinkSync(real, link);
    process.env.PROTON_DRIVE_LOCAL_ROOT = link;
    assert.throws(() => assertLocalPathAllowed(join(link, "x")), /symlink/);
  });
  it("a root inside the home folder is fine when it does not contain protected locations", () => {
    const root = join(fakeHome, "projects");
    mkdirSync(root);
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    assertLocalPathAllowed(join(root, "a.txt"));
  });
  it("mixed-case spelling of an existing root resolves through the on-disk case (case-insensitive volumes only)", () => {
    const root = mkroot("Docs");
    const upper = root.replace(/Docs-/, "DOCS-");
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    const caseInsensitive = existsSync(upper);
    if (caseInsensitive) assertLocalPathAllowed(join(upper, "a.txt"));
    else assert.throws(() => assertLocalPathAllowed(join(upper, "a.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
  });
  it("a Unicode-normalised spelling is either the same directory (and allowed) or a different one (and refused)", () => {
    const nfc = "café";
    const root = mkroot(nfc);
    process.env.PROTON_DRIVE_LOCAL_ROOT = root;
    const nfd = root.replace(nfc, nfc.normalize("NFD"));
    if (existsSync(nfd)) assertLocalPathAllowed(join(nfd, "a.txt"));
    else assert.throws(() => assertLocalPathAllowed(join(nfd, "a.txt")), /outside PROTON_DRIVE_LOCAL_ROOT/);
  });
});

describe("PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH=1", () => {
  it("lifts the allowlist, but the denylist stays as defence in depth", () => {
    process.env.PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH = "1";
    assert.equal(describeRoots().mode, "any");
    assertLocalPathAllowed(join(base, "anywhere.txt"));
    mkdirSync(join(fakeHome, ".ssh"));
    assert.throws(() => assertLocalPathAllowed(join(fakeHome, ".ssh", "id_x")), /protected location/);
    assert.throws(() => assertLocalPathAllowed(join(base, ".env")), /secret file/);
  });
  it("only exactly '1' counts", () => {
    process.env.PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH = "true";
    assert.throws(() => assertLocalPathAllowed(join(base, "x.txt")), /outside the default local folder/);
  });
});

describe("tools enforce the allowlist before the CLI", () => {
  it("upload, download and photo transfers outside the allowed folder never spawn the CLI", async () => {
    const sb = makeSandbox();
    const root = join(base, "mcp-root");
    mkdirSync(root);
    const c = await startServer("json", sb, { PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH: "", PROTON_DRIVE_LOCAL_ROOT: root, HOME: fakeHome });
    try {
      const outside = join(base, "outside.txt");
      writeFileSync(outside, "x");
      const calls = [
        ["drive_upload", { localPath: outside, remotePath: "/my-files" }],
        ["drive_download", { remotePath: "/my-files/a.txt", localPath: join(base, "dl") }],
        ["photos_download", { photoPaths: ["/photos/a.jpg"], localFolder: join(base, "ph") }],
        ["photos_upload", { localPaths: [outside] }],
        ["drive_sync_plan", { localPath: base, drivePath: "/my-files" }],
      ];
      for (const [tool, args] of calls) {
        const r = await c.call(tool, args);
        assert.equal(r.isError, true, tool);
        assert.match(r.text, /outside PROTON_DRIVE_LOCAL_ROOT/, tool);
      }
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    } finally { await c.close(); sb.cleanup(); }
  });
  it("a sync folder that is the home folder is refused for read_file/write_file", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH: "", PROTON_DRIVE_SYNC_PATH: fakeHome, HOME: fakeHome });
    try {
      const r = await c.call("drive_read_file", { path: "/my-files/a.txt" });
      assert.equal(r.isError, true);
      assert.match(r.text, /home folder|protected/);
    } finally { await c.close(); sb.cleanup(); }
  });
});
