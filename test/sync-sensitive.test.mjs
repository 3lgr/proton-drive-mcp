// N-02: drive_read_file refuses known secrets and credential folders, judging names as the file system does
// (case, Unicode form, invisible characters, trailing dots/spaces) and both the spelling and the resolved path.
// drive_write_file no longer exists: nothing in this server writes into the sync folder.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readSyncFile } from "../dist/utils/syncfs.js";
import { foldName } from "../dist/utils/syncGuard.js";
import { makeSandbox, startServer } from "./helpers/mcp-client.mjs";

const READ_REFUSED = [
  "/my-files/proj/.env", "/my-files/proj/.env.local", "/my-files/id_ed25519", "/my-files/k.pem", "/my-files/.ssh/config", "/my-files/proj/.git/config", "/my-files/.netrc",
  "/my-files/proj/.ENV", "/my-files/proj/.env.", "/my-files/proj/.env ", "/my-files/ID_RSA", "/my-files/K.PEM", "/my-files/p/.GIT/config", "/my-files/.SSH/config",
  "/my-files/．env", "/my-files/.​env", "/my-files/p/.Git/config", "/my-files/.aws/credentials", "/my-files/x/.kube/config",
];

describe("N-02 drive_read_file refuses known secrets", () => {
  let root;
  before(() => { root = mkdtempSync(join(tmpdir(), "syncsens-")); });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const p of READ_REFUSED) {
    it(`refused: ${JSON.stringify(p)}`, async () => {
      const real = join(root, p.replace(/^\/my-files/, ""));
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, "SECRET=1"); // created by the operator, not through the tool
      await assert.rejects(() => readSyncFile(root, p), /protected|sensitive|refus/i);
    });
  }
  it("an in-root symlink with an innocent name cannot hide a secret (the real path is judged)", async () => {
    writeFileSync(join(root, "real.pem"), "KEY");
    symlinkSync(join(root, "real.pem"), join(root, "innocent.txt"));
    await assert.rejects(() => readSyncFile(root, "/my-files/innocent.txt"), /protected|sensitive|refus/i);
  });
  it("a symlinked parent that points into a credential folder is refused", async () => {
    mkdirSync(join(root, "vault", ".ssh"), { recursive: true });
    writeFileSync(join(root, "vault", ".ssh", "notes.txt"), "x");
    symlinkSync(join(root, "vault", ".ssh"), join(root, "plainlink"));
    await assert.rejects(() => readSyncFile(root, "/my-files/plainlink/notes.txt"), /protected|sensitive|refus/i);
  });
  it("an ordinary file, and ordinary names that merely contain the words, are readable", async () => {
    writeFileSync(join(root, "plain.txt"), "hello");
    writeFileSync(join(root, "environment.txt"), "env doc");
    writeFileSync(join(root, "pem-notes.md"), "notes");
    for (const p of ["/my-files/plain.txt", "/my-files/environment.txt", "/my-files/pem-notes.md"]) {
      assert.ok((await readSyncFile(root, p)).length > 0, p);
    }
  });
  it("foldName: NFKC, invisible code points, case, trailing dots and spaces", () => {
    assert.equal(foldName(".GIT"), ".git");
    assert.equal(foldName("．git"), ".git");
    assert.equal(foldName(".​git"), ".git");
    assert.equal(foldName(".git. ."), ".git");
    assert.equal(foldName("café"), foldName("café"));
  });
  it("PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 lifts the rule; any other value keeps it", async () => {
    writeFileSync(join(root, ".env.optout"), "x");
    const prev = process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS;
    try {
      process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "yes";
      await assert.rejects(() => readSyncFile(root, "/my-files/.env.optout"), /refus/i);
      process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = "1";
      assert.equal(await readSyncFile(root, "/my-files/.env.optout"), "x");
    } finally { if (prev === undefined) delete process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS; else process.env.PROTON_DRIVE_ALLOW_SENSITIVE_PATHS = prev; }
  });
});

describe("N-02 through the MCP tools", () => {
  it("drive_read_file refuses .env; drive_write_file is not offered", async () => {
    const sync = mkdtempSync(join(tmpdir(), "syncsens-e2e-"));
    writeFileSync(join(sync, ".env"), "TOKEN=abc");
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_SYNC_PATH: sync });
    try {
      const r = await c.call("drive_read_file", { path: "/my-files/.env" });
      assert.equal(r.isError, true);
      assert.doesNotMatch(r.text, /TOKEN=abc/);
      assert.equal((await c.listTools()).some((t) => t.name === "drive_write_file"), false);
      const w = await c.call("drive_write_file", { path: "/my-files/x.txt", content: "x" }).catch((e) => ({ isError: true, text: String(e.message) }));
      assert.equal(w.isError, true);
    } finally { await c.close(); sb.cleanup(); rmSync(sync, { recursive: true, force: true }); }
  });
});
