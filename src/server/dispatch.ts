// The single place a tool call is authorised and executed. Order, with no alternative path:
//   1. the tool must have a handler AND a policy (otherwise: unknown tool; startup already refuses such a registry)
//   2. consent "dispatcher": arguments validated and normalised, consent obtained, only then the handler runs with
//      the normalised arguments
//   3. consent "handler": the handler runs with a guarded `drive`: a mutating call before the gate was evaluated
//      throws (fail closed)
//   4. any exception on the way is a refusal; nothing runs after it
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { DriveService } from "../services/drive.js";
import type { Args } from "../policy/gates.js";
import type { SharePolicy } from "../policy/sharePolicy.js";
import { strMarker } from "../utils/safeOutput.js";
import { HANDLERS } from "./handlers/index.js";
import { MUTATING_METHODS, TOOL_POLICY, type PolicyContext } from "./policy.js";
import type { Handler, HandlerContext } from "./context.js";
import type { ToolResult } from "./result.js";
import { resolveAllowedLocal, assertSyncRootUsable, anyLocalPathAllowed } from "../utils/localguard.js";
import { getSyncRoot } from "../utils/syncfs.js";

export interface DispatchDeps {
  readonly drive: DriveService;
  readonly sharePolicy: SharePolicy;
  readonly canElicit: () => boolean;
  /** Evaluates one gate (human prompt / policy). Throws NeedsConfirmationError when the call may not proceed. */
  readonly gate: (tool: string, a: Args, prompt?: string) => Promise<void>;
  readonly handlers?: Readonly<Record<string, Handler>>;
}

function guardedDrive(drive: DriveService, required: () => boolean, evaluated: () => boolean): DriveService {
  return new Proxy(drive, {
    get(target, prop, _receiver) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (typeof prop === "string" && MUTATING_METHODS.has(prop) && required() && !evaluated()) {
          throw new Error(`blocked: ${prop} was called before its consent gate was evaluated`);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export async function dispatchTool(name: string, a: Args, deps: DispatchDeps): Promise<ToolResult> {
  const handlers = deps.handlers ?? HANDLERS;
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  const policy = Object.hasOwn(TOOL_POLICY, name) ? TOOL_POLICY[name] : undefined;
  if (!handler || !policy) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool ${strMarker(String(name))}`);

  // The local allowlist is enforced here for every tool that declares local paths, before anything else.
  if (policy.local) {
    for (const k of policy.local.args ?? []) if (typeof a[k] === "string") resolveAllowedLocal(a[k] as string);
    for (const k of policy.local.listArgs ?? []) {
      const list = a[k];
      if (Array.isArray(list)) for (const p of list) if (typeof p === "string") resolveAllowedLocal(p);
    }
    if (policy.local.syncRoot) {
      const root = getSyncRoot();
      if (root && !anyLocalPathAllowed()) assertSyncRootUsable(root);
    }
  }

  const pctx: PolicyContext = { drive: deps.drive, sharePolicy: deps.sharePolicy, canElicit: deps.canElicit };
  let args = a;
  let evaluated = false;

  if (policy.consent === "dispatcher") {
    args = await policy.validate!(a, pctx);              // throws on anything invalid: nothing is asked, nothing runs
    const prompt = await policy.prompt?.(args, pctx);
    await deps.gate(name, args, prompt);                 // throws unless approved
    evaluated = true;
  }

  const required = (): boolean => policy.consent === "handler" && policy.gateRequired!(args);
  const ctx: HandlerContext = {
    drive: guardedDrive(deps.drive, required, () => evaluated),
    sharePolicy: deps.sharePolicy,
    canElicit: deps.canElicit,
    gate: async (tool, ga, prompt) => { await deps.gate(tool, ga, prompt); evaluated = true; },
    assertConsent: () => { if (required() && !evaluated) throw new Error("blocked: the consent gate was not evaluated"); },
  };
  return handler(args, ctx);
}
