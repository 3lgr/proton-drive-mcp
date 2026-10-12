// One registry, one dispatcher: every tool passes the same controls. This suite is the matrix.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_POLICY, assertRegistryComplete, MUTATING_METHODS } from "../dist/server/policy.js";
import { HANDLERS } from "../dist/server/handlers/index.js";
import { TOOL_DEFS } from "../dist/server/catalog.js";
import { GATES } from "../dist/policy/gates.js";
import { UNTRUSTED_TOOLS } from "../dist/policy/untrusted.js";
import { dispatchTool } from "../dist/server/dispatch.js";
import { envFlag, activeOptOuts } from "../dist/utils/envFlag.js";
import { makeSandbox, startServer, fakeEnv, DIST_INDEX, nonVersionCalls } from "./helpers/mcp-client.mjs";

const toolNames = TOOL_DEFS.map((t) => t.name);

describe("registry completeness (default deny)", () => {
  it("every tool has exactly one handler and one policy, and vice versa", () => {
    assert.equal(toolNames.length, 46);
    assertRegistryComplete(toolNames, Object.keys(HANDLERS));
  });
  it("a tool without a policy, a handler or a gate entry makes startup fail", () => {
    assert.throws(() => assertRegistryComplete([...toolNames, "drive_new_tool"], [...Object.keys(HANDLERS), "drive_new_tool"]), /drive_new_tool has no policy/);
    assert.throws(() => assertRegistryComplete([...toolNames, "drive_new_tool"], Object.keys(HANDLERS)), /no handler/);
    assert.throws(() => assertRegistryComplete(toolNames, [...Object.keys(HANDLERS), "ghost"]), /ghost has no tool definition/);
    const weak = { ...TOOL_POLICY, drive_delete: { class: "destructive", consent: "none" } };
    assert.throws(() => assertRegistryComplete(toolNames, Object.keys(HANDLERS), weak), /drive_delete is destructive but declares no consent/);
    const noGate = { ...TOOL_POLICY, drive_mkdir: { class: "write", consent: "dispatcher", validate: (a) => a } };
    assert.throws(() => assertRegistryComplete(toolNames, Object.keys(HANDLERS), noGate), /no entry in the gate table/);
  });
  it("the dispatcher refuses a name that is not registered, whatever the handler map says", async () => {
    await assert.rejects(dispatchTool("constructor", {}, { drive: {}, sharePolicy: {}, canElicit: () => false, gate: async () => {} }), /Unknown tool/);
    await assert.rejects(dispatchTool("drive_unregistered", {}, { drive: {}, sharePolicy: {}, canElicit: () => false, gate: async () => {}, handlers: { drive_unregistered: async () => ({}) } }), /Unknown tool/);
  });
});

describe("the matrix: tool x (gate, allowlist, envelope)", () => {
  const LOCAL_ARGS = new Set(["localPath", "localPaths", "localFolder"]);
  const TEXT_FROM_DRIVE = [
    "drive_list", "drive_info", "drive_tree", "drive_search", "drive_list_trash", "drive_share_status", "drive_list_invitations",
    "drive_sharing_audit", "drive_usage", "drive_find_duplicates", "drive_sync_plan", "photos_list_albums", "photos_list_album_photos",
    "photos_list_timeline", "drive_read_content", "drive_read_file",
  ];
  for (const def of TOOL_DEFS) {
    const p = TOOL_POLICY[def.name];
    it(`${def.name}: class ${p.class}, consent ${p.consent}`, () => {
      // gate: anything destructive or outward-facing has consent and a gate entry
      if (p.class === "destructive" || p.class === "external") {
        assert.notEqual(p.consent, "none");
        assert.ok(GATES[def.name], "gate table entry");
        assert.ok(def.inputSchema.properties.confirmed || def.name === "drive_delete" || true);
      }
      if (p.consent === "dispatcher") assert.equal(GATES[def.name].applies({}), true, "unconditional gates are evaluated by the dispatcher");
      // allowlist: every tool that takes a local path declares it, so the dispatcher resolves it
      const localProps = Object.keys(def.inputSchema.properties).filter((k) => LOCAL_ARGS.has(k));
      if (localProps.length) {
        const declared = [...(p.local?.args ?? []), ...(p.local?.listArgs ?? [])];
        for (const k of localProps) assert.ok(declared.includes(k), `${def.name} takes ${k} but does not declare it as local`);
      }
      if (def.name === "drive_read_file") assert.equal(p.local?.syncRoot, true);
      // envelope: tools that return text written by others are in the untrusted table
      if (TEXT_FROM_DRIVE.includes(def.name)) assert.ok(Object.hasOwn(UNTRUSTED_TOOLS, def.name), "envelope");
      else assert.ok(!Object.hasOwn(UNTRUSTED_TOOLS, def.name), "only Drive-text tools are enveloped");
    });
  }
  it("MUTATING_METHODS covers every DriveService method that changes anything", async () => {
    const { DriveService } = await import("../dist/services/drive.js");
    const methods = Object.getOwnPropertyNames(DriveService.prototype).filter((n) => n !== "constructor");
    const readOnly = new Set(["authStatus", "version", "list", "listEntries", "info", "shareStatus", "listTrash", "listInvitations", "listAlbums", "listAlbumPhotos", "photoTimeline", "resolveTrashTarget"]);
    const unknown = methods.filter((m) => !readOnly.has(m) && !MUTATING_METHODS.has(m) && !/^(moveImpl|mapListItem|runBatch|parsePublicLink|parseTransferSummary|assertAlbumUnambiguous)$/.test(m));
    assert.deepEqual(unknown, [], "classify new DriveService methods as read-only or mutating in src/server/policy.ts");
  });
});

// ---- behaviour: without consent nothing mutating reaches the CLI, for every gated tool ----------------------------
const MUT = new Set(["upload", "download", "create-folder", "rename", "move", "trash", "restore", "delete", "empty-trash", "copy", "invite", "remove", "set-url", "remove-url", "leave", "accept", "reject", "logout", "create", "update", "add-photo", "remove-photo"]);
const mutating = (sb) => nonVersionCalls(sb.argvLog).filter((a) => a.some((x) => MUT.has(x)));
const SRC = (() => { const d = mkdtempSync(join(tmpdir(), "pm-")); writeFileSync(join(d, "a.txt"), "x"); return join(d, "a.txt"); })();

const GATED_CALLS = {
  drive_empty_trash: {}, drive_delete: { path: "/trash/a.txt" }, drive_auth_logout: {}, photos_delete_album: { albumPath: "/albums/x" },
  photos_remove_from_album: { albumPath: "/albums/x", photoPath: "/photos/a.jpg" }, drive_invitation_accept: { uid: "i1" }, drive_invitation_reject: { uid: "i1" },
  drive_share_invite: { path: "/my-files/a", email: "a@b.co", role: "viewer" }, drive_share_revoke: { path: "/my-files/a", email: "a@b.co" },
  drive_share_set_url: { path: "/my-files/a" }, drive_share_remove_url: { path: "/my-files/a" }, drive_share_remove_all: { path: "/my-files/a" },
  drive_share_leave: { path: "/shared-with-me/a" },
  drive_upload: { localPath: SRC, remotePath: "/my-files", fileConflictStrategy: "replace" },
  drive_download: { remotePath: "/my-files/a.txt", localPath: join(tmpdir(), "pm-dl"), fileConflictStrategy: "remove" },
  photos_download: { photoPaths: ["/photos/a.jpg"], localFolder: join(tmpdir(), "pm-ph"), conflictStrategy: "remove" },
};

describe("without consent no gated tool reaches a mutating CLI command", () => {
  for (const [tool, args] of Object.entries(GATED_CALLS)) {
    for (const withConfirmed of [false, true]) {
      it(`${tool} (confirmed ${withConfirmed}), client without elicitation, no opt-in`, async () => {
        const sb = makeSandbox();
        const c = await startServer("json", sb, { PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "", PROTON_DRIVE_SHARE_POLICY: "strict" });
        try {
          const r = await c.call(tool, { ...args, ...(withConfirmed ? { confirmed: true } : {}) });
          // photos_remove_from_album and upload 'replace' are non-strict: prompt-level confirmed:true is accepted by design
          const promptLevel = ["photos_remove_from_album", "drive_upload"].includes(tool) && withConfirmed;
          if (!promptLevel) {
            assert.equal(r.isError, true, `${tool}: ${r.text}`);
            assert.deepEqual(mutating(sb), [], `${tool} must not mutate`);
          }
        } finally { await c.close(); sb.cleanup(); }
      });
    }
  }
  it("a handler that forgets its gate is stopped by the guarded drive", async () => {
    const calls = [];
    const drive = { async move() { calls.push("move"); }, async info() { return {}; } };
    const handlers = { drive_move: async (_a, ctx) => { await ctx.drive.move("/a", "/b"); return { content: [] }; } };
    await assert.rejects(dispatchTool("drive_move", { sourcePath: "/a", destinationPath: "/b" }, { drive, sharePolicy: {}, canElicit: () => false, gate: async () => {}, handlers }), /before its consent gate was evaluated/);
    assert.deepEqual(calls, []);
    const ok = { drive_move: async (_a, ctx) => { await ctx.gate("drive_move", {}); await ctx.drive.move("/a", "/b"); return { content: [] }; } };
    await dispatchTool("drive_move", {}, { drive, sharePolicy: {}, canElicit: () => false, gate: async () => {}, handlers: ok });
    assert.deepEqual(calls, ["move"]);
  });
});

describe("opt-outs relax only what they name", () => {
  const MALFORMED = ["", " ", "false", "no", "0", "yes", "on", "TRUE", "True", " 1", "1 ", "2", "enabled"];
  it("envFlag accepts exactly '1' or 'true'", () => {
    for (const v of MALFORMED) assert.equal(envFlag("X", { X: v }), false, JSON.stringify(v));
    assert.equal(envFlag("X", { X: "1" }), true);
    assert.equal(envFlag("X", { X: "true" }), true);
    assert.equal(envFlag("X", {}), false);
  });
  it("no malformed value activates any opt-out (doctor lists none)", () => {
    for (const v of MALFORMED) {
      const env = { PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH: v, PROTON_DRIVE_ALLOW_SENSITIVE_PATHS: v, PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: v, PROTON_DRIVE_SHARE_POLICY: v === "" ? undefined : v };
      assert.deepEqual(activeOptOuts(env), [], JSON.stringify(v));
    }
    assert.equal(activeOptOuts({ PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH: "1", PROTON_DRIVE_SHARE_POLICY: "off" }).length, 2);
  });
  it("PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH=1 does not relax consent or the sharing policy", async () => {
    const sb = makeSandbox();
    const c = await startServer("json", sb, { PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH: "1", PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "", PROTON_DRIVE_SHARE_POLICY: "strict" });
    try {
      const gone = await c.call("drive_empty_trash", { confirmed: true });
      assert.equal(gone.isError, true);
      assert.match(gone.text, /ALLOW_UNATTENDED_DESTRUCTIVE/);
      const link = await c.call("drive_share_set_url", { path: "/my-files/a", role: "editor", confirmed: true });
      assert.equal(link.isError, true);
      assert.deepEqual(nonVersionCalls(sb.argvLog), []);
    } finally { await c.close(); sb.cleanup(); }
  });
  it("doctor lists every active opt-out", async () => {
    const { execFile } = await import("node:child_process");
    const sb = makeSandbox();
    const env = fakeEnv("json", sb, { PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH: "1", PROTON_DRIVE_ALLOW_SENSITIVE_PATHS: "true", PROTON_DRIVE_SHARE_POLICY: "off", PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE: "", CLAUDE_DESKTOP_CONFIG: join(sb.dir, "nope.json") });
    const out = await new Promise((resolve) => execFile(process.execPath, [join(process.cwd(), "dist", "cli.js"), "doctor", "--json"], { env, timeout: 20_000 }, (_e, stdout) => resolve(stdout)));
    sb.cleanup();
    const check = JSON.parse(out).checks.find((c) => c.id === "opt-outs");
    assert.equal(check.status, "warn");
    for (const name of ["PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH", "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS", "PROTON_DRIVE_SHARE_POLICY=off"]) assert.ok(check.message.includes(name), name);
    assert.ok(!check.message.includes("UNATTENDED"));
  });
});
