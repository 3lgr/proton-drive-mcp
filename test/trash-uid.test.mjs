// drive_restore / drive_delete on trashed items with duplicate names.
// CLI v0.8.0 resolves /trash/<x> by name only (first match), so acting on a
// shared name would hit an arbitrary item — these must refuse instead.
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { execFile } from "node:child_process";
import { DriveService } from "../dist/services/drive.js";
import { makeSandbox, startServer, fakeEnv, nonVersionCalls, DIST_CLI } from "./helpers/mcp-client.mjs";

const U1 = "vol~dupA";
const U2 = "vol~dupB";
const U3 = "vol~solo";
const TRASH = [
  { uid: U1, name: { ok: true, value: "x.txt" }, type: "file", trashTime: "2026-09-01T00:00:00Z" },
  { uid: U2, name: { ok: true, value: "x.txt" }, type: "file", trashTime: "2026-09-02T00:00:00Z" },
  { uid: U3, name: { ok: true, value: "solo.txt" }, type: "file" },
];

function makeRunner() {
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    return args[1] === "list" ? TRASH : [];
  };
  return { runner, calls };
}
const mutations = (calls) => calls.filter((c) => c[1] !== "list");

for (const op of ["restore", "delete"]) {
  describe(`DriveService.${op} on trash`, () => {
    it("refuses a path shared by several trashed items, listing uids and trash times, without mutating", async () => {
      const t = makeRunner();
      await assert.rejects(new DriveService(t.runner)[op]("/trash/x.txt"), (e) => {
        assert.match(e.message, /2 trashed items share the path \/trash\/x\.txt/);
        assert.ok(e.message.includes(U1) && e.message.includes(U2));
        assert.ok(e.message.includes("2026-09-01T00:00:00Z"));
        return true;
      });
      assert.deepEqual(mutations(t.calls), []);
    });

    it("refuses a uid whose name is shared (the CLI cannot target one duplicate)", async () => {
      const t = makeRunner();
      await assert.rejects(new DriveService(t.runner)[op](undefined, U2), /share the path/);
      assert.deepEqual(mutations(t.calls), []);
    });

    it("forwards a unique uid as its /trash/<name> path (the only form the CLI resolves)", async () => {
      const t = makeRunner();
      await new DriveService(t.runner)[op](undefined, U3);
      assert.deepEqual(mutations(t.calls), [["filesystem", op, "/trash/solo.txt"]]);
    });

    it("rejects path and uid that refer to different items", async () => {
      const t = makeRunner();
      await assert.rejects(new DriveService(t.runner)[op]("/trash/x.txt", U3), /does not match uid/);
      assert.deepEqual(mutations(t.calls), []);
    });

    it("rejects an unknown uid", async () => {
      const t = makeRunner();
      await assert.rejects(new DriveService(t.runner)[op](undefined, "vol~gone"), /No item with uid/);
      assert.deepEqual(mutations(t.calls), []);
    });

    it("still works by path when exactly one item matches", async () => {
      const t = makeRunner();
      await new DriveService(t.runner)[op]("/trash/solo.txt");
      assert.deepEqual(mutations(t.calls), [["filesystem", op, "/trash/solo.txt"]]);
    });

    it("accepts matching path and uid", async () => {
      const t = makeRunner();
      await new DriveService(t.runner)[op]("/trash/solo.txt", U3);
      assert.deepEqual(mutations(t.calls), [["filesystem", op, "/trash/solo.txt"]]);
    });
  });
}

describe("MCP drive_restore / drive_delete", () => {
  const cleanups = [];
  after(() => cleanups.forEach((f) => f()));
  async function server() {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { FAKE_STDOUT: JSON.stringify(TRASH) });
    cleanups.push(() => { c.close(); sb.cleanup(); });
    return { c, calls: () => nonVersionCalls(sb.argvLog).filter((a) => a[1] !== "list") };
  }

  it("drive_delete refuses an ambiguous path and makes no delete call", async () => {
    const { c, calls } = await server();
    const r = await c.call("drive_delete", { path: "/trash/x.txt", confirmed: true });
    assert.equal(r.isError, true);
    assert.ok(r.text.includes(U1) && r.text.includes(U2));
    assert.deepEqual(calls(), []);
  });

  it("drive_restore accepts uid alone", async () => {
    const { c, calls } = await server();
    const r = await c.call("drive_restore", { uid: U3 });
    assert.notEqual(r.isError, true, r.text);
    assert.deepEqual(calls().map((a) => a.slice(0, 3)), [["filesystem", "restore", "/trash/solo.txt"]]);
  });

  it("drive_delete still requires confirmed with uid", async () => {
    const { c, calls } = await server();
    const r = await c.call("drive_delete", { uid: U3 });
    assert.equal(r.isError, true);
    assert.deepEqual(calls(), []);
  });
});

describe("companion CLI --uid", () => {
  function runCli(args) {
    const sb = makeSandbox();
    return new Promise((resolve) => {
      execFile(process.execPath, [DIST_CLI, ...args], { env: fakeEnv("json", sb, { FAKE_STDOUT: JSON.stringify(TRASH) }), timeout: 20_000 }, (err, stdout, stderr) => {
        const calls = nonVersionCalls(sb.argvLog).filter((a) => a[1] !== "list");
        sb.cleanup();
        resolve({ code: err ? 1 : 0, stderr, calls });
      });
    });
  }

  it("restore --uid forwards the unique item's trash path", async () => {
    const r = await runCli(["restore", "--uid", U3]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls.map((a) => a.slice(0, 3)), [["filesystem", "restore", "/trash/solo.txt"]]);
  });

  it("delete of an ambiguous path exits 1 and makes no delete call", async () => {
    const r = await runCli(["delete", "/trash/x.txt", "--confirm"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(U1));
    assert.deepEqual(r.calls, []);
  });
});

// N-03: the human approves a NAME, not an opaque uid; and the name the uid resolves to is validated again.
describe("N-03 drive_delete by uid", () => {
  const RLO = String.fromCodePoint(0x202e);
  const items = [
    { uid: "vol~solo", name: { ok: true, value: "solo.txt" }, type: "file" },
    { uid: "vol~dots", name: { ok: true, value: ".." }, type: "file" },
    { uid: "vol~dot", name: { ok: true, value: "." }, type: "file" },
    { uid: "vol~bidi", name: { ok: true, value: `fa${RLO}txt.exe` }, type: "file" },
  ];
  const runner = () => { const calls = []; return { calls, fn: async (args) => { calls.push([...args]); return args[1] === "list" ? items : []; } }; };

  for (const uid of ["vol~dots", "vol~dot"]) {
    it(`a uid that resolves to the name of a directory entry (${uid}) is refused before any spawn`, async () => {
      for (const op of ["delete", "restore"]) {
        const t = runner();
        await assert.rejects(new DriveService(t.fn)[op](undefined, uid), /not a valid trash item|\. or \.\./);
        assert.deepEqual(mutations(t.calls), []);
      }
    });
  }
  it("the path form /trash/.. is refused too", async () => {
    const t = runner();
    await assert.rejects(new DriveService(t.fn).delete("/trash/.."), /not a valid trash item|\. or \.\./);
    assert.deepEqual(mutations(t.calls), []);
  });

  async function withElicit(handler, fn) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const { DIST_INDEX } = await import("./helpers/mcp-client.mjs");
    const sb = makeSandbox();
    const client = new Client({ name: "t", version: "0" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, handler);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX], env: fakeEnv("json", sb, { FAKE_STDOUT: JSON.stringify(items) }) }));
    try { await fn(client, sb); } finally { await client.close(); sb.cleanup(); }
  }

  it("the approval prompt shows the resolved, escaped name next to the uid", async () => {
    let msg = "";
    await withElicit(async (req) => { msg = req.params.message; return { action: "decline" }; }, async (client, sb) => {
      const r = await client.callTool({ name: "drive_delete", arguments: { uid: "vol~bidi", confirmed: true } });
      assert.equal(r.isError, true);
      assert.deepEqual(mutations(nonVersionCalls(sb.argvLog)), []);
    });
    assert.match(msg, /Target: .*fa.*txt\.exe/);
    assert.match(msg, /vol~bidi/);
    assert.ok(!msg.includes(RLO), "the bidi override must be escaped, not rendered");
  });

  it("an unknown or unresolvable uid is refused before the human is asked", async () => {
    let asked = 0;
    await withElicit(async () => { asked++; return { action: "accept", content: { approve: true } }; }, async (client, sb) => {
      for (const uid of ["vol~gone", "vol~dots"]) {
        const r = await client.callTool({ name: "drive_delete", arguments: { uid, confirmed: true } });
        assert.equal(r.isError, true, uid);
      }
      assert.deepEqual(mutations(nonVersionCalls(sb.argvLog)), []);
    });
    assert.equal(asked, 0);
  });
});
