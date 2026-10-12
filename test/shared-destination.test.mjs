// N-01: the shared-destination gate fails closed, looks at the whole ancestor chain and covers every tool that
// can put data into a folder or album that other people can see.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandbox, startServer, fakeEnv, DIST_INDEX, nonVersionCalls } from "./helpers/mcp-client.mjs";

const MEMBERS = { members: [{ inviteeEmail: "a@b.co", role: "viewer" }] };
const SRC = join(mkdtempSync(join(tmpdir(), "sd-")), "src.txt");
writeFileSync(SRC, "x");
const strict = { PROTON_DRIVE_SHARE_POLICY: "strict" };
const map = (m) => JSON.stringify(m);
const calls = (sb, group, verb) => nonVersionCalls(sb.argvLog).filter((a) => a[0] === group && a[1] === verb);

async function withElicit(answer, fn, env = {}) {
  const sb = makeSandbox();
  const prompts = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(req.params.message);
    return answer === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" };
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX], env: fakeEnv("json", sb, env) });
  await client.connect(transport);
  try { await fn(client, sb, prompts); } finally { await client.close(); sb.cleanup(); }
}

describe("N-01 lookup failure fails closed", () => {
  it("a failed sharing lookup is treated as shared: the human is asked and the copy waits", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_copy", arguments: { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub" } });
      assert.equal(r.isError, true);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /could not be verified/);
      assert.deepEqual(calls(sb, "filesystem", "copy"), []);
    }, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/pub": "ERR:Error: network is down" }) });
  });

  it("share policy off keeps the lookup out of the way", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_copy", arguments: { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub" } });
      assert.notEqual(r.isError, true);
      assert.equal(prompts.length, 0);
      assert.equal(calls(sb, "sharing", "status").length, 0);
    }, { PROTON_DRIVE_SHARE_POLICY: "off", FAKE_SHARE_MAP: map({ "/my-files/pub": "ERR:boom" }) });
  });
});

describe("N-01 ancestors", () => {
  it("a shared ancestor makes a deep destination shared (copy)", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_copy", arguments: { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub/sub/deep" } });
      assert.equal(r.isError, true);
      assert.match(prompts[0], /already shared with other people/);
      assert.deepEqual(calls(sb, "filesystem", "copy"), []);
    }, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/pub": MEMBERS }) });
  });

  it("a shared ancestor makes a deep destination shared (move)", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_move", arguments: { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub/sub/x.txt" } });
      assert.equal(r.isError, true);
      assert.equal(prompts.length, 1);
      assert.deepEqual(calls(sb, "filesystem", "move"), []);
    }, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/pub": MEMBERS }) });
  });

  it("a destination that does not exist yet inherits from its ancestors (shared ancestor asks, private one does not)", async () => {
    const notFound = "ERR:Item not found: /my-files/pub/new";
    await withElicit("decline", async (client, _sb, prompts) => {
      const r = await client.callTool({ name: "drive_copy", arguments: { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub/new" } });
      assert.equal(r.isError, true);
      assert.equal(prompts.length, 1);
    }, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/pub/new": notFound, "/my-files/pub": MEMBERS }) });
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_copy", arguments: { sourcePath: "/my-files/a/x.txt", destinationPath: "/my-files/pub/new" } });
      assert.notEqual(r.isError, true);
      assert.equal(prompts.length, 0);
      assert.equal(calls(sb, "filesystem", "copy").length, 1);
    }, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/pub/new": notFound }) });
  });

  it("bulk move: the prompt warns about a shared ancestor and about an unverifiable lookup", async () => {
    const list = map({ "/my-files/s": [{ name: "x.txt", type: "file" }], "/my-files/pub/sub": [] });
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_bulk_move", arguments: { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/pub/sub", confirmed: true } });
      assert.equal(r.isError, true);
      assert.match(prompts[0], /already shared with other people/);
      assert.deepEqual(nonVersionCalls(sb.argvLog).filter((a) => a[1] === "move"), []);
    }, { ...strict, FAKE_LIST_MAP: list, FAKE_SHARE_MAP: map({ "/my-files/pub": MEMBERS }) });
    await withElicit("decline", async (_client, _sb, prompts) => {
      await _client.callTool({ name: "drive_bulk_move", arguments: { sources: ["/my-files/s/x.txt"], destinationFolder: "/my-files/pub/sub", confirmed: true } });
      assert.match(prompts[0], /could not be verified/);
    }, { ...strict, FAKE_LIST_MAP: list, FAKE_SHARE_MAP: map({ "/my-files/pub/sub": "ERR:timeout" }) });
  });
});

describe("N-01 upload and album gates", () => {
  it("drive_upload into a shared folder asks the human, naming the destination; decline uploads nothing", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_upload", arguments: { localPath: SRC, remotePath: "/my-files/pub/inbox" } });
      assert.equal(r.isError, true);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /already shared with other people/);
      assert.match(prompts[0], /\/my-files\/pub\/inbox/);
      assert.deepEqual(calls(sb, "filesystem", "upload"), []);
    }, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/pub": MEMBERS }) });
  });

  it("drive_upload into a private folder is not gated; an unverifiable lookup is", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_upload", arguments: { localPath: SRC, remotePath: "/my-files/priv" } });
      assert.notEqual(r.isError, true);
      assert.equal(prompts.length, 0);
      assert.equal(calls(sb, "filesystem", "upload").length, 1);
    }, strict);
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "drive_upload", arguments: { localPath: SRC, remotePath: "/my-files/priv" } });
      assert.equal(r.isError, true);
      assert.match(prompts[0], /could not be verified/);
      assert.deepEqual(calls(sb, "filesystem", "upload"), []);
    }, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/priv": "ERR:boom" }) });
  });

  it("client without elicitation: drive_upload into a shared folder is refused until confirmed:true", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { ...strict, FAKE_SHARE_MAP: map({ "/my-files/pub": MEMBERS }) });
    try {
      const no = await c.call("drive_upload", { localPath: SRC, remotePath: "/my-files/pub/inbox" });
      assert.equal(no.isError, true);
      assert.match(no.text, /confirmed=true/);
      assert.deepEqual(calls(sb, "filesystem", "upload"), []);
      const yes = await c.call("drive_upload", { localPath: SRC, remotePath: "/my-files/pub/inbox", confirmed: true });
      assert.equal(yes.isError, false, yes.text);
    } finally { await c.close(); sb.cleanup(); }
  });

  const SHARED_ALBUM = JSON.stringify([{ uid: "al1", name: { ok: true, value: "Fam" }, isShared: true, album: { photoCount: 1 } }]);
  const PRIVATE_ALBUM = JSON.stringify([{ uid: "al2", name: { ok: true, value: "Mine" }, isShared: false, album: { photoCount: 1 } }]);
  const addArgs = (name) => ({ albumPath: `/albums/${name}`, photoPath: "/photos/x.jpg" });

  it("photos_add_to_album into a shared album asks the human; decline adds nothing", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "photos_add_to_album", arguments: addArgs("Fam") });
      assert.equal(r.isError, true);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /already shared with other people/);
      assert.deepEqual(calls(sb, "album", "add-photo"), []);
    }, { ...strict, FAKE_ALBUMS: SHARED_ALBUM });
  });

  it("photos_add_to_album: a private album is not gated; an album that cannot be verified is", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "photos_add_to_album", arguments: addArgs("Mine") });
      assert.notEqual(r.isError, true);
      assert.equal(prompts.length, 0);
      assert.equal(calls(sb, "album", "add-photo").length, 1);
    }, { ...strict, FAKE_ALBUMS: PRIVATE_ALBUM });
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "photos_add_to_album", arguments: addArgs("Ghost") });
      assert.equal(r.isError, true);
      assert.match(prompts[0], /could not be verified/);
      assert.deepEqual(calls(sb, "album", "add-photo"), []);
    }, { ...strict, FAKE_ALBUMS: PRIVATE_ALBUM });
  });

  it("photos_upload goes to the private timeline: no destination to gate, no sharing lookup", async () => {
    await withElicit("decline", async (client, sb, prompts) => {
      const r = await client.callTool({ name: "photos_upload", arguments: { localPaths: [SRC] } });
      assert.notEqual(r.isError, true, JSON.stringify(r));
      assert.equal(prompts.length, 0);
      assert.equal(calls(sb, "sharing", "status").length, 0);
    }, strict);
  });
});
