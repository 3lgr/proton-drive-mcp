// The output choke point. Anything that leaves this process through a log line or an error returned to the model is
// built from a CLOSED vocabulary: error codes with fixed text, tool names, counters, durations, statuses. A free
// string coming from the CLI, the file system, the remote side or a user (names, paths, e-mail addresses, URLs,
// stderr, tokens) is never emitted: it is replaced by a marker that carries only its length and a short salted hash,
// enough to tell two values apart in a bug report and nothing more. Pattern-based redaction (redact.ts) stays as a
// second layer for developer-authored messages; it is not the barrier.
import { createHash, randomBytes } from "node:crypto";

const SALT = randomBytes(8); // per process: markers can not be matched across runs or precomputed

/** «str:len=42 id=a1b2» (deliberately not the \u27e6 \u27e7 glyphs, which are reserved for the content sanitiser): the value's UTF-16 length and 16 bits of a salted hash. */
export function strMarker(value: string): string {
  const id = createHash("sha256").update(SALT).update(value).digest("hex").slice(0, 4);
  return `«str:len=${value.length} id=${id}»`;
}

export const ERROR_CODES = {
  NOT_FOUND: "the item was not found; check the path with drive_list or drive_search",
  ALREADY_EXISTS: "an item with that name already exists at the destination",
  QUOTA_EXCEEDED: "storage quota exceeded",
  BUSY: "the CLI's local cache is busy (database is locked); retry in a moment",
  RATE_LIMITED: "Proton is rate limiting requests; wait and retry",
  NETWORK: "a network error occurred while talking to Proton",
  PERMISSION_DENIED: "the operation is not permitted for this account or item",
  LOCAL_FILE: "a local file or folder is missing, unreadable or not writable",
  INVALID_ARGUMENT: "the CLI rejected the arguments of this call",
  TIMEOUT: "the operation timed out",
  CANCELLED: "the operation was cancelled",
  CLI_FAILED: "the proton-drive CLI failed",
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

// Phrases are matched, never emitted. Order matters: the first match wins.
const CLASSIFIERS: ReadonlyArray<readonly [ErrorCode, RegExp]> = [
  ["LOCAL_FILE", /\b(enoent|eacces|eperm|eisdir|enotdir|erofs|enospc)\b|no such file or directory|permission denied, (open|mkdir|scandir)/i],
  ["BUSY", /database is locked|SQLITE_BUSY/i],
  ["QUOTA_EXCEEDED", /quota|storage (is )?full|not enough (storage|space)|insufficient storage/i],
  ["ALREADY_EXISTS", /already exists|same name|NodeWithSameName|name conflict|duplicate name/i],
  ["RATE_LIMITED", /too many (server )?requests|rate.?limit|\b429\b/i],
  ["NOT_FOUND", /not found|does not exist|no such (node|item|album|invitation)|NodeNotFound|unknown (path|node)/i],
  ["PERMISSION_DENIED", /\b(403|forbidden)\b|not (permitted|allowed|authori[sz]ed)|insufficient permissions?|access denied/i],
  ["NETWORK", /econn(reset|refused)|etimedout|eai_again|enotfound|socket hang up|network|offline|timed out|\b50[234]\b|timeout error/i],
  ["INVALID_ARGUMENT", /unknown (option|flag|argument|command)|invalid (option|argument|value)|usage:|required (option|argument)/i],
];

/** Fixed-text description of a failure the CLI reported. The CLI's own words are only classified, never repeated. */
export function describeCliFailure(output: string, exit?: number | string): { code: ErrorCode; message: string } {
  const code = CLASSIFIERS.find(([, re]) => re.test(output))?.[0] ?? "CLI_FAILED";
  const where = typeof exit === "number" ? ` (exit ${exit})` : "";
  return { code, message: `${ERROR_CODES[code]}${where} [${code}]. CLI output withheld: ${strMarker(output)}` };
}

/** One field of a log event, made safe: free strings and objects become markers, errors become class and code. */
export function safeValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (typeof v === "string") return strMarker(v);
  if (v instanceof Error) {
    const code = (v as { code?: unknown }).code;
    return `${v.name}${typeof code === "string" || typeof code === "number" ? `(code=${String(code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)})` : ""}`;
  }
  if (Array.isArray(v)) return `«array:len=${v.length}»`;
  if (typeof v === "object") return `«object:keys=${Object.keys(v as object).length}»`;
  return `«${typeof v}»`;
}
