import type { DriveService } from "../services/drive.js";
import type { Args } from "../policy/gates.js";
import type { SharePolicy } from "../policy/sharePolicy.js";
import type { ToolResult } from "./result.js";

/** What a tool handler may use. Gates and policy come in through here, so handlers stay small and testable. */
export interface HandlerContext {
  readonly drive: DriveService;
  /** Throws NeedsConfirmationError unless the call may proceed (see policy/gates.ts and policy/approval.ts). */
  readonly gate: (tool: string, a: Args, prompt?: string) => Promise<void>;
  readonly canElicit: () => boolean;
  readonly sharePolicy: SharePolicy;
}

export type Handler = (a: Record<string, unknown>, ctx: HandlerContext) => Promise<ToolResult>;
