// Shapes every tool response and error. presentResult() is the single choke point (F-07).
import { DriveCliNotFoundError, DriveCliError, DriveNotAuthenticatedError, DriveParseError, NeedsConfirmationError } from "../utils/errors.js";
import { AlbumPhoto } from "../types/index.js";
import { UNTRUSTED_TOOLS, wrapUntrusted, sanitizeMessage, sanitizeDeep, newStats } from "../policy/untrusted.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

export function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function handleError(err: unknown): ToolResult {
  if (err instanceof NeedsConfirmationError) return fail(err.message);
  if (err instanceof DriveCliNotFoundError) return fail(err.message);
  if (err instanceof DriveNotAuthenticatedError) return fail(err.message);
  if (err instanceof DriveCliError) return fail(`CLI error: ${truncate(err.message)}`);
  if (err instanceof DriveParseError) return fail(`Parse error: ${err.message}`);
  if (err instanceof Error) return fail(truncate(err.message));
  return fail(`Unexpected error: ${truncate(String(err))}`);
}

// F-07: the single place every tool response passes through. Drive-originated text is wrapped in the envelope;
// every other string (acks, errors, partial results) goes through the same sanitiser. No path around it.
export function presentResult(tool: string, r: ToolResult): ToolResult {
  const first = r.content[0];
  if (!first) return r;
  const text = (t: string): ToolResult => ({ ...r, content: [{ type: "text", text: t }] });
  if (r.isError) return text(sanitizeMessage(first.text));
  let parsed: unknown;
  try { parsed = JSON.parse(first.text); } catch { return text(sanitizeMessage(first.text)); }
  if (tool in UNTRUSTED_TOOLS) return text(JSON.stringify(wrapUntrusted(tool, parsed)));
  return text(JSON.stringify(sanitizeDeep(parsed, [], newStats())));
}

export function paginate<T>(all: T[], a: Record<string, unknown>, defaultLimit: number) {
  const limit = typeof a.limit === "number" ? a.limit : defaultLimit;
  const offset = typeof a.offset === "number" ? a.offset : 0;
  const items = all.slice(offset, offset + limit);
  return { total: all.length, offset, limit, hasMore: offset + items.length < all.length, items };
}

// Every page re-runs the CLI, whose order is not stable, so paginated lists
// must be put in a total order before slicing or pages lose/duplicate items.
export function byTimeDescThenId<T>(time: (x: T) => string | undefined, id: (x: T) => string | undefined) {
  return (x: T, y: T) => {
    const t = (time(y) ?? "").localeCompare(time(x) ?? "");
    if (t) return t;
    const a = id(x) ?? "", b = id(y) ?? "";
    return a < b ? -1 : a > b ? 1 : 0;
  };
}
export const photoOrder = byTimeDescThenId<AlbumPhoto>((p) => p.captureTime, (p) => p.nodeUid);

