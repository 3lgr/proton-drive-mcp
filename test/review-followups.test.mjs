// Follow-ups from the independent second-pass review: bulk guards, path DoS, shared destinations, invitation prompt,
// child environment, temp-dir thaw, expiration format, prototype lookups.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { validateRemotePath } from "../dist/utils/validation.js";
import { makeIgnore, planBulkTrash } from "../dist/services/plan.js";
import { buildChildEnv } from "../dist/utils/childEnv.js";
import { registerTempDir, removeAllTempDirsSync } from "../dist/utils/tempDirs.js";
import { checkPublicLink, loadSharePolicy } from "../dist/policy/sharePolicy.js";
import { makeSandbox, startServer, fakeEnv, DIST_INDEX, nonVersionCalls } from "./helpers/mcp-client.mjs";

describe("bulk operations honour the root guards", () => {
  const drive = new DriveService(async () => []);
  it("bulkTrash/bulkMove refuse roots in any spelling before the CLI is called", async () => {
    for (const p of ["/my-files", "/MY-FILES", "/trash", "/"]) {
      await assert.rejects(drive.bulkTrash([p]), /root/);
      await assert.rejects(drive.bulkMove([p], "/my-files/x"), /root/);
    }
    await assert.rejects(drive.bulkMove(["/my-files/a"], "/trash"), /root/);
  });
  it("the plan treats '/My-Files' as a root too", () => {
    const listing = new Map([["/", new Set(["My-Files"])]]);
    const plan = planBulkTrash(["/My-Files"], listing);
    assert.ok(plan.problems.some((p) => /root/.test(p.problem)));
  });
});

describe("remote paths", () => {
  it("empty segments are refused instead of being read differently by the CLI", () => {
    for (const p of ["//my-files", "/my-files//a", "/a///b"]) assert.throws(() => validateRemotePath(p), /empty segments/);
    assert.equal(validateRemotePath("/a\\//b"), "/a\\//b", "an escaped slash followed by a separator is legitimate");
    assert.equal(validateRemotePath("/my-files/a/"), "/my-files/a");
  });
  it("hostile slash runs and overlong paths cost no CPU and are refused", () => {
    const t0 = Date.now();
    assert.throws(() => validateRemotePath("/" + "/".repeat(2_000_000) + "x"));
    assert.throws(() => validateRemotePath("/" + "a".repeat(5000)), /longer than 4096/);
    const ign = makeIgnore(["a" + "/".repeat(1_000_000)]);
    ign("a/b");
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  });
});

describe("child environment", () => {
  it("passes PROTON_DRIVE_* but not other Proton products' variables", () => {
    const env = buildChildEnv({ PROTON_DRIVE_X: "1", PROTON_PASS_TOKEN: "s", PROTON_VPN_KEY: "k", HOME: "/h" });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PROTON_DRIVE_X"]);
  });
});

describe("frozen temp directories are removable", () => {
  it("removeAllTempDirsSync thaws read-only trees first", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdmcp-upload-frozen-"));
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "f"), "x");
    chmodSync(join(root, "d", "f"), 0o400);
    chmodSync(join(root, "d"), 0o500);
    chmodSync(root, 0o500);
    registerTempDir(root);
    removeAllTempDirsSync();
    assert.equal(existsSync(root), false);

    // the sweeper (marker-based) is covered in sweep-owned.test.mjs
  });
});

describe("share policy expiration format", () => {
  const strict = loadSharePolicy({});
  it("accepts an ISO date or timestamp, refuses trailing junk that the legacy parser would swallow", () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    checkPublicLink(strict, { role: "viewer", password: "longenough1", expiration: soon.slice(0, 10) });
    checkPublicLink(strict, { role: "viewer", password: "longenough1", expiration: soon });
    for (const bad of [`${soon.slice(0, 10)}junk`, "2026-12-31 25:00", `${soon.slice(0, 10)}T99:99Z`, "12/31/2026"]) {
      assert.throws(() => checkPublicLink(strict, { role: "viewer", password: "longenough1", expiration: bad }), /ISO date|past|90 days/, bad);
    }
  });
});

describe("tool and argument lookups use own properties only", () => {
  it("'constructor' is an unknown tool, and {constructor:1} an unknown argument", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb);
    try {
      const r = await c.callRaw("constructor", {});
      assert.ok(r.error && r.error.code === -32601, JSON.stringify(r));
      const a = await c.call("drive_list", { path: "/my-files", constructor: 1 });
      assert.equal(a.isError, true);
      assert.match(a.text, /Unknown argument/);
    } finally { await c.close(); sb.cleanup(); }
  });
});

async function withElicit(handler, fn, env = {}) {
  const sb = makeSandbox();
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, handler);
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX], env: fakeEnv("json", sb, env) });
  await client.connect(transport);
  try { await fn(client, sb); } finally { await client.close(); sb.cleanup(); }
}

describe("moving or copying into an already shared folder needs approval", () => {
  const shared = JSON.stringify({ members: [{ inviteeEmail: "a@b.co", role: "viewer" }] });
  const mutations = (sb) => nonVersionCalls(sb.argvLog).filter((a) => a[0] === "filesystem" && (a[1] === "move" || a[1] === "copy"));

  it("elicitation client: the human is asked, with the destination named; decline moves nothing", async () => {
    let msg = "";
    await withElicit(async (req) => { msg = req.params.message; return { action: "decline" }; }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_move", arguments: { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub/x.txt" } });
      assert.equal(r.isError, true);
      assert.deepEqual(mutations(sb), []);
    }, { FAKE_STDOUT: shared, PROTON_DRIVE_SHARE_POLICY: "strict" });
    assert.match(msg, /already shared with other people/);
    assert.match(msg, /destinationPath: \/my-files\/pub\/x\.txt/);
  });

  it("client without elicitation: refused until confirmed:true; then it runs", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { FAKE_STDOUT: shared, PROTON_DRIVE_SHARE_POLICY: "strict" });
    try {
      const no = await c.call("drive_copy", { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub" });
      assert.equal(no.isError, true);
      assert.match(no.text, /confirmed=true/);
      assert.deepEqual(mutations(sb), []);
      const yes = await c.call("drive_copy", { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub", confirmed: true });
      assert.equal(yes.isError, false, yes.text);
    } finally { await c.close(); sb.cleanup(); }
  });

  it("an unshared destination (or share policy off) is not gated", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_SHARE_POLICY: "strict" });
    try {
      assert.equal((await c.call("drive_move", { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/priv/x.txt" })).isError, false);
    } finally { await c.close(); sb.cleanup(); }
  });
});

describe("accepting an invitation shows who sends what", () => {
  it("the prompt names the sender, the item and the role (escaped), not just a uid", async () => {
    const inv = [{ uid: "inv-1", role: "editor", addedByEmail: { ok: true, value: "boss@x.com" }, node: { name: { ok: true, value: "Q3 plan" }, type: "folder" } }];
    let msg = "";
    await withElicit(async (req) => { msg = req.params.message; return { action: "decline" }; }, async (client) => {
      await client.callTool({ name: "drive_invitation_accept", arguments: { uid: "inv-1", confirmed: true } });
    }, { FAKE_STDOUT: JSON.stringify(inv) });
    assert.match(msg, /from: boss@x\.com/);
    assert.match(msg, /item: Q3 plan \(folder\)/);
    assert.match(msg, /role: editor/);
  });
  it("an unknown uid is refused before any prompt", async () => {
    let asked = 0;
    await withElicit(async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client) => {
      const r = await client.callTool({ name: "drive_invitation_accept", arguments: { uid: "nope", confirmed: true } });
      assert.equal(r.isError, true);
    }, { FAKE_STDOUT: "[]" });
    assert.equal(asked, 0);
  });
});
