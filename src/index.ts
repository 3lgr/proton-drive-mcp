#!/usr/bin/env node
import { removeAllTempDirsSync } from "./utils/tempDirs.js";
import { createRequire } from "node:module";
import { showValue } from "./utils/text.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DriveService } from "./services/drive.js";
import { PROMPTS, getPromptText } from "./prompts.js";
import { isMainModule } from "./utils/isMainModule.js";
import { checkCliAvailable, runDriveRaw, callContext, killAllChildren } from "./utils/subprocess.js";
import { NeedsConfirmationError } from "./utils/errors.js";
import { logger } from "./utils/logger.js";
import { cliCompatWarning } from "./utils/cliVersion.js";
import { abortBackgroundRefreshes } from "./services/walk.js";
import { sweepStaleTempDirs } from "./utils/tempSweep.js";
import { GATES, refusalMessage, type Args } from "./policy/gates.js";
import { createApprover } from "./policy/approval.js";
import { strMarker } from "./utils/safeOutput.js";
import { loadSharePolicy } from "./policy/sharePolicy.js";
import { HANDLERS } from "./server/handlers/index.js";
import { dispatchTool } from "./server/dispatch.js";
import { assertRegistryComplete } from "./server/policy.js";
import { TOOL_DEFS, CORE_TOOL_NAMES, LARGE_RESULT_TOOLS, resolveTier } from "./server/catalog.js";
import { checkArgs } from "./server/schema.js";
import { ok, fail, handleError, presentResult, type ToolResult } from "./server/result.js";
import { describeArgs } from "./server/approvalText.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = pkg.version ?? "1.0.0";

process.env["PROTON_DRIVE_MCP"] = "1";

// Public surface used by tests and embedders.
export { CORE_TOOL_NAMES, resolveTier } from "./server/catalog.js";
export { describeArgs } from "./server/approvalText.js";
export { showValue };

// The SDK's prompts/get schema types arguments as string-only, and a violation surfaces as -32603.
// Accept any JSON value here so getPromptText can reject it as InvalidParams (-32602).
const GetPromptLooseSchema = GetPromptRequestSchema.extend({
  params: GetPromptRequestSchema.shape.params.extend({ arguments: CallToolRequestSchema.shape.params.shape.arguments }),
});

async function elicitApproval(server: Server, message: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await server.elicitInput(
      {
        message,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve this action", default: false } }, required: ["approve"] },
      },
      { timeout: 120_000, signal },
    );
    return res.action === "accept" && res.content?.approve === true;
  } catch {
    return false;
  }
}

export async function main() {
  // Default deny: a tool without a policy (or a handler, or the other way round) stops the server from starting.
  assertRegistryComplete(TOOL_DEFS.map((t) => t.name), Object.keys(HANDLERS));
  const drive = new DriveService();
  const tier = resolveTier(process.env.PROTON_DRIVE_TOOL_TIER); // read once at startup
  const activeDefs = tier === "core" ? TOOL_DEFS.filter((t) => CORE_TOOL_NAMES.has(t.name)) : TOOL_DEFS;

  const sharePolicy = loadSharePolicy(); // read once at startup
  const canElicit = () => !!server.getClientCapabilities()?.elicitation?.form;
  // One approval policy for every gate (src/policy): the human is always asked when the client can ask;
  // otherwise strict tools fail closed unless the operator opted in. A looping model cannot spam the human.
  const approve = createApprover({
    canElicit,
    elicit: (message) => elicitApproval(server, message, callContext.getStore()?.signal),
  });
  /** Throws NeedsConfirmationError unless the call may proceed. `prompt` overrides the default human-facing text. */
  const gate = async (tool: string, a: Args, prompt?: string): Promise<void> => {
    const spec = GATES[tool];
    if (!spec || !spec.applies(a)) return;
    const message = prompt ?? `${tool} needs your approval. It ${spec.consequence}\n${describeArgs(a)}`;
    const verdict = await approve(tool, spec, a, message);
    if (verdict.allowed) return;
    throw new NeedsConfirmationError(verdict.kind === "needs-confirm" ? refusalMessage(tool) : verdict.message);
  };

  const server = new Server(
    { name: "proton-drive-mcp", version: VERSION },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeDefs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      ...(t.title ? { title: t.title } : {}),
      ...(LARGE_RESULT_TOOLS.has(t.name) ? { _meta: { "anthropic/maxResultSizeChars": 100000 } } : {}),
    })),
  }));

  // A prompt is offered only when every tool it tells the model to call is in the active tier.
  const activeToolNames = new Set(activeDefs.map((t) => t.name));
  const activePrompts = PROMPTS.filter((p) => p.requires.every((r) => activeToolNames.has(r)));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: activePrompts.map(({ requires: _requires, ...p }) => ({ ...p, arguments: [...p.arguments] })),
  }));

  server.setRequestHandler(GetPromptLooseSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    let text: string | undefined;
    try {
      text = activePrompts.some((p) => p.name === name) ? getPromptText(name, args) : undefined;
    } catch (err) {
      throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
    }
    if (text === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    const def = PROMPTS.find((p) => p.name === name);
    return { description: def?.description, messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
  });

  const handleCall = async (req: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> => {
    const { name, arguments: args = {} } = req.params;
    let a = args as Record<string, unknown>;

    const def = TOOL_DEFS.find((t) => t.name === name);
    // A client may remember a name from a fuller tools/list; refuse before any CLI call.
    if (def && !activeDefs.includes(def)) {
      return fail(`Tool ${name} is not available in the "${tier}" tool tier. Set PROTON_DRIVE_TOOL_TIER=full and restart the server to use it.`);
    }
    if (def) {
      const problem = checkArgs(def, a);
      if (problem) {
        // `confirmed` is schema-required on the destructive tools. For a client that can ask the human, a missing
        // `confirmed` must still reach the gate (which prompts); any other validation failure stays an error.
        const asConfirmFalse = { ...a, confirmed: false };
        if (a.confirmed !== undefined && a.confirmed !== null || !canElicit() || checkArgs(def, asConfirmFalse)) return fail(problem);
        a = asConfirmFalse;
      }
    }

    try {
      return await dispatchTool(name, a, { drive, gate, canElicit, sharePolicy });
    } catch (err) {
      if (err instanceof McpError) throw err;
      return handleError(err);
    }
  };

  let inFlight = 0;
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    inFlight++;
    try {
      // The request's AbortSignal reaches the CLI child via AsyncLocalStorage, so
      // notifications/cancelled actually kills a running upload/download.
      const result = await callContext.run({ signal: extra?.signal }, () => handleCall(req));
      return presentResult(req.params.name, result);
    } finally {
      inFlight--;
    }
  });

  const shutdown = (code: number) => {
    abortBackgroundRefreshes();
    killAllChildren();
    removeAllTempDirsSync();
    process.exit(code);
  };
  server.onclose = () => { abortBackgroundRefreshes(); killAllChildren(); removeAllTempDirsSync(); };
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
  process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") shutdown(0); });
  process.on("uncaughtException", (err) => { logger.error("Uncaught exception:", err); shutdown(1); });
  process.on("unhandledRejection", (err) => { logger.error("Unhandled rejection:", err); shutdown(1); });
  // Host went away: let in-flight calls finish briefly (one-shot `echo | node` use),
  // then kill whatever CLI is still running instead of lingering until its timeout.
  process.stdin.on("end", () => {
    if (inFlight > 0) setTimeout(() => shutdown(0), 15_000).unref();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("proton-drive-mcp running, version", VERSION);
  void sweepStaleTempDirs(); // after connect so it can never delay initialize; best-effort, never throws

  // Probe the CLI after connecting so a slow `version` can never delay
  // `initialize` (hosts time out at ~5s). A missing CLI still leaves the server
  // up: tools/list works and each call returns a clear error.
  void checkCliAvailable().then((cliCheck) => {
    if (!cliCheck.available) {
      logger.error(cliCheck.reason === "integrity" ? "proton-drive CLI refused by the integrity check (run `proton-drive-cli doctor` for the reason)" : cliCheck.reason === "not_executable"
        ? "proton-drive CLI found but not executable. Run: chmod +x $(which proton-drive)"
        : "proton-drive CLI not found. Download from https://proton.me/download/drive/cli/index.html, or set PROTON_DRIVE_BIN to its absolute path (find it with `which proton-drive`).");
    } else {
      // One stderr line (the logger never writes stdout); best effort, never fatal.
      runDriveRaw(["version"]).then((t) => { const w = cliCompatWarning(t); if (w) logger.warn(w); }, () => {}); // w is built from digits and constants only (cliVersion.ts)
    }
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    logger.error("Fatal:", err);
    process.exit(1);
  });
}
