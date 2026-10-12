// Decides whether a gated call may proceed. The model controls `confirmed`, so on its own it is never
// proof of consent: when the client can ask the human (MCP elicitation) the human is ALWAYS asked.
import type { Args, GateSpec } from "./gates.js";
import { envFlag } from "../utils/envFlag.js";

export const UNATTENDED_ENV = "PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE";
const WINDOW_MS = 60_000;
const MAX_DECLINES_PER_WINDOW = 5;

export interface ApprovalDeps {
  canElicit: () => boolean;
  /** Asks the human; resolves true only on an explicit approval. May throw (treated as a decline). */
  elicit: (message: string) => Promise<boolean>;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}

export type Verdict =
  | { allowed: true; via: "human" | "model-confirmed" | "unattended-optin" }
  | { allowed: false; kind: "declined" | "needs-confirm" | "blocked-no-elicitation" | "rate-limited"; message: string };

export type Approver = (tool: string, spec: GateSpec, a: Args, promptMessage: string) => Promise<Verdict>;

export function createApprover(deps: ApprovalDeps): Approver {
  const declines: number[] = [];
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;

  return async (tool, spec, a, promptMessage) => {
    if (deps.canElicit()) {
      const t = now();
      while (declines.length && t - declines[0]! > WINDOW_MS) declines.shift();
      if (declines.length >= MAX_DECLINES_PER_WINDOW) {
        return { allowed: false, kind: "rate-limited", message: `${tool} not executed: too many declined approval prompts in the last minute. Do not retry; ask the user what they want.` };
      }
      let approved = false;
      try { approved = await deps.elicit(promptMessage); } catch { approved = false; }
      if (approved) return { allowed: true, via: "human" };
      declines.push(t);
      return { allowed: false, kind: "declined", message: `${tool} not executed: the user did not approve it. Do not retry unless the user asks for it.` };
    }

    // The client cannot ask the human, so nothing but the model's own flag is left.
    const confirmed = a.confirmed === true;
    if (spec.strict) {
      if (!envFlag(UNATTENDED_ENV, env)) {
        return {
          allowed: false, kind: "blocked-no-elicitation",
          message:
            `${tool} is blocked: it is irreversible or outward-facing, and this MCP client cannot ask the user for approval (no elicitation support), ` +
            `so a model-supplied confirmed=true is not accepted as consent. Ask the user to run it themselves (proton-drive-cli, with --confirm), ` +
            `or to start this server with ${UNATTENDED_ENV}=1 if they accept that the model can run it unattended.`,
        };
      }
      return confirmed
        ? { allowed: true, via: "unattended-optin" }
        : { allowed: false, kind: "needs-confirm", message: "" };
    }
    return confirmed ? { allowed: true, via: "model-confirmed" } : { allowed: false, kind: "needs-confirm", message: "" };
  };
}
