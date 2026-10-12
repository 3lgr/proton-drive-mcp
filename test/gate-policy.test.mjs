// F-01 end to end: a model-supplied confirmed:true is never consent by itself.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, startServer, fakeEnv, DIST_INDEX, nonVersionCalls } from "./helpers/mcp-client.mjs";

const text = (r) => r.content[0].text;
const UPLOAD_SRC = join(mkdtempSync(join(tmpdir(), "gp-")), "src.txt");
writeFileSync(UPLOAD_SRC, "x");

async function withElicitingClient(handler, fn, extraEnv = {}) {
  const sb = makeSandbox();
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, handler);
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX], env: fakeEnv("json", sb, extraEnv) });
  await client.connect(transport);
  try { await fn(client, sb); } finally { await client.close(); sb.cleanup(); }
}

async function withPlainClient(fn, extraEnv = {}) {
  const sb = makeSandbox();
  const c = await startServer("json", sb, extraEnv);
  try { await fn(c, sb); } finally { await c.close(); sb.cleanup(); }
}

// Every strict tool with arguments that pass validation, so only the gate decides.
const STRICT_CALLS = [
  ["drive_empty_trash", { confirmed: true }],
  ["drive_delete", { path: "/trash/a.txt", confirmed: true }],
  ["drive_auth_logout", { confirmed: true }],
  ["photos_delete_album", { albumPath: "/albums/x", confirmed: true }],
  ["drive_invitation_reject", { uid: "inv1", confirmed: true }],
  ["drive_invitation_accept", { uid: "inv1", confirmed: true }],
  ["drive_share_invite", { path: "/my-files/a", email: "a@b.co", role: "viewer", confirmed: true }],
  ["drive_share_revoke", { path: "/my-files/a", email: "a@b.co", confirmed: true }],
  ["drive_share_set_url", { path: "/my-files/a", confirmed: true }],
  ["drive_share_remove_url", { path: "/my-files/a", confirmed: true }],
  ["drive_share_remove_all", { path: "/my-files/a", confirmed: true }],
  ["drive_share_leave", { path: "/shared-with-me/a", confirmed: true }],
  ["drive_download", { remotePath: "/my-files/a.txt", localPath: "/tmp/pdmcp-gate-out", fileConflictStrategy: "remove", confirmed: true }],
  ["photos_download", { photoPaths: ["/photos/a.jpg"], localFolder: "/tmp/pdmcp-gate-out", conflictStrategy: "remove", confirmed: true }],
];

describe("no elicitation support: strict tools fail closed", () => {
  for (const [tool, args] of STRICT_CALLS) {
    it(`${tool} with confirmed:true is refused and never reaches the CLI`, async () => {
      await withPlainClient(async (c, sb) => {
        const r = await c.call(tool, args);
        assert.equal(r.isError, true, r.text);
        assert.match(r.text, /PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE/);
        assert.deepEqual(nonVersionCalls(sb.argvLog), []);
      }, { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "" });
    });
  }

  it("the documented opt-in restores prompt-level confirmation", async () => {
    await withPlainClient(async (c, sb) => {
      const refused = await c.call("drive_empty_trash", {});
      assert.equal(refused.isError, true);
      const r = await c.call("drive_empty_trash", { confirmed: true });
      assert.equal(r.isError, false, r.text);
      assert.ok(nonVersionCalls(sb.argvLog).some((a) => a.includes("empty-trash")));
    }, { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "1" });
  });

  it("non-strict gated tools still accept confirmed:true without elicitation", async () => {
    await withPlainClient(async (c) => {
      const r = await c.call("photos_remove_from_album", { albumPath: "/albums/x", photoPath: "/photos/a.jpg", confirmed: true });
      assert.equal(r.isError, false, r.text);
    }, { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "" });
  });

  it("ungated tools are unaffected", async () => {
    await withPlainClient(async (c) => {
      assert.equal((await c.call("drive_list", { path: "/my-files" })).isError, false);
      assert.equal((await c.call("drive_trash", { path: "/my-files/a.txt" })).isError, false);
    }, { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "" });
  });
});

describe("elicitation support: the human is asked even when the model says confirmed:true", () => {
  it("trash then empty-trash chain: confirmed:true does not skip the prompt", async () => {
    let asked = 0;
    await withElicitingClient(async () => { asked++; return { action: "decline" }; }, async (client, sb) => {
      await client.callTool({ name: "drive_trash", arguments: { path: "/my-files/a.txt" } });
      const r = await client.callTool({ name: "drive_empty_trash", arguments: { confirmed: true } });
      assert.equal(r.isError, true);
      assert.match(text(r), /did not approve/);
      assert.equal(asked, 1);
      assert.ok(!nonVersionCalls(sb.argvLog).some((a) => a.includes("empty-trash")));
    });
  });

  it("an approved prompt runs the tool exactly once", async () => {
    let asked = 0;
    await withElicitingClient(async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_empty_trash", arguments: { confirmed: true } });
      assert.notEqual(r.isError, true, text(r));
      assert.equal(asked, 1);
      assert.equal(nonVersionCalls(sb.argvLog).filter((a) => a.includes("empty-trash")).length, 1);
    });
  });

  it("the opt-in env is irrelevant when the client can ask: still asked", async () => {
    let asked = 0;
    await withElicitingClient(async () => { asked++; return { action: "decline" }; }, async (client) => {
      const r = await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt", confirmed: true } });
      assert.equal(r.isError, true);
      assert.equal(asked, 1);
    }, { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "1" });
  });

  it("conditional gates ask only for the dangerous strategy", async () => {
    let asked = 0;
    await withElicitingClient(async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client) => {
      await client.callTool({ name: "drive_upload", arguments: { localPath: UPLOAD_SRC, remotePath: "/my-files", fileConflictStrategy: "rename" } });
      assert.equal(asked, 0);
      await client.callTool({ name: "drive_upload", arguments: { localPath: UPLOAD_SRC, remotePath: "/my-files", fileConflictStrategy: "replace", confirmed: true } });
      assert.equal(asked, 1);
    });
  });

  it("the prompt shows the consequence and the arguments, not the model's own reassurance", async () => {
    let msg = "";
    await withElicitingClient(async (req) => { msg = req.params.message; return { action: "decline" }; }, async (client) => {
      await client.callTool({ name: "drive_delete", arguments: { path: "/trash/a.txt", confirmed: true } });
    });
    assert.match(msg, /PERMANENTLY deletes/);
    assert.match(msg, /\/trash\/a\.txt/);
  });
});
