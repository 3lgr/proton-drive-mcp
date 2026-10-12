// Pure helpers behind DriveService: shaping CLI nodes, escaping names in the CLI's path syntax, and turning the
// per-item {ok, error} arrays the CLI returns into thrown errors.
import type { AlbumPhoto } from "../types/index.js";

// The SDK verifies the author of every name (and several other fields)
// cryptographically and returns a `Result<string, Error>`-shaped object —
// {ok:true, value:"name"} on success, {ok:false, error:{...}} if the
// signature couldn't be verified — never a plain string. Confirmed live
// against the CLI's `filesystem list`, `filesystem info`, `album list`,
// `invitation list` output. A naive `String(item.name)` on this object
// produces the literal text "[object Object]".
export function unwrapResult(value: unknown, fallback = ""): string {
  if (value && typeof value === "object" && "ok" in value) {
    const r = value as { ok: boolean; value?: unknown };
    if (r.ok && typeof r.value === "string") return r.value;
    return fallback;
  }
  return typeof value === "string" ? value : fallback;
}

// The CLI's own path syntax requires escaping a literal '/' inside a node
// name with a backslash (confirmed in `filesystem info --help`: "Escape /
// in node names with a backslash"). Our own validateName() rejects '/' in
// names WE create, but an item created by any other Proton Drive client
// (web, desktop, mobile) can still have a literal '/' in its name. Confirmed
// live: naively joining such a name into a path ("/parent/raw/slash") makes
// every path-based tool (info, download, move, rename, delete, ...) fail
// with "Node not found", while the correctly escaped form ("/parent/raw\/slash")
// resolves. list() must escape names before building the path it returns.
export function escapeNameForPath(name: string): string {
  return name.replace(/\//g, "\\/");
}

export function unescapeName(name: string): string {
  return name.replace(/\\\//g, "/");
}

// dirname/basename that respect the "\/" escape: node's posix.basename would
// split "/a/raw\/slash" into "slash", corrupting mkdir/move on such items.
export function splitRemotePath(p: string): { parent: string; name: string } {
  for (let i = p.length - 1; i >= 0; i--) {
    if (p[i] === "/" && p[i - 1] !== "\\") {
      return { parent: i === 0 ? "/" : p.slice(0, i), name: p.slice(i + 1) };
    }
  }
  return { parent: "/", name: p };
}

export function joinRemote(parent: string, escapedName: string): string {
  return `${parent === "/" ? "" : parent}/${escapedName}`;
}

// filesystem move/copy/trash/restore/delete all accept multiple paths in one
// call and report per-item success as an array of {uid, ok, error} — NOT via
// a non-zero exit code. Confirmed live: a name collision at the destination
// makes `filesystem move`/`filesystem copy` exit 0 with
// [{ok:false, error:{name:"NodeWithSameNameExistsValidationError", ...}}].
// Every one of these wrappers previously discarded the result outright, so a
// collision was silently reported as success. Worst case was move(): it then
// went on to rename whatever OTHER item happened to already be sitting at the
// computed destination path — silently renaming an unrelated file while the
// real source never moved.
// The API's bare codes are opaque; these meanings were confirmed live
// (2026-09-28) for the action they are keyed by.
const READABLE_ERRORS: Record<string, string> = {
  "Copy|InvalidRequirementsAPIError|2000": "Proton cannot copy this item: big folders cannot be copied yet (CLI limitation)",
  "Move|InvalidRequirementsAPIError|2000": "the destination is inside the source, or the source no longer exists",
  "Restore|APICodeError|2511": "its original parent folder is still in the trash — restore the parent first",
  "Add to album|APICodeError|2500": "that photo is already in the album",
};

export function assertItemsOk(result: unknown, action: string): void {
  if (!Array.isArray(result)) return;
  for (const item of result as Record<string, unknown>[]) {
    if (item && item.ok === false) {
      const err = (item.error ?? {}) as Record<string, unknown>;
      const name = String(err.name ?? "unknown error");
      const code = typeof err.code !== "undefined" ? ` (code ${err.code})` : "";
      const message = typeof err.message === "string" && err.message ? `: ${err.message}` : "";
      const readable = READABLE_ERRORS[`${action}|${name}|${err.code}`];
      if (readable) throw new Error(`${action} failed: ${readable} (${name}${code}${message})`);
      // Only a real collision deserves the collision hint — the same wrapper also
      // reports move-into-itself, restore-with-trashed-parent, etc.
      const hint = name === "NodeWithSameNameExistsValidationError"
        ? " — an item with that name already exists at the destination."
        : "";
      throw new Error(`${action} failed: ${name}${code}${message}${hint}`);
    }
  }
}


// Strips "<package-name>@" and "+<hash>" from a version token like
// "cli-drive@0.8.0+06e8c605", leaving "0.8.0". Falls back to the raw
// token if it doesn't match, so an unexpected future format still shows
// something rather than silently becoming "unknown".
export function extractSemver(token: string | undefined): string {
  if (!token) return "unknown";
  const afterAt = token.includes("@") ? token.slice(token.indexOf("@") + 1) : token;
  const semverMatch = afterAt.match(/^(\d+\.\d+\.\d+)/);
  return semverMatch ? semverMatch[1] : token;
}

// drive_info used to return the raw node: ~40% of it is lossless noise — the
// {ok,value} verification wrappers, uid chains repeated per revision, and
// fields that duplicate others. Unwrap the wrappers and drop the noise; the raw
// node is still available with verbose=true.
const NODE_NOISE = new Set(["treeEventScopeId", "parentUid", "keyAuthor", "nameAuthor", "claimedDigests", "isImported"]);
export function trimNode(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.map((x) => trimNode(x, depth + 1));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.ok === true && "value" in o) return trimNode(o.value, depth + 1);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      if (NODE_NOISE.has(k)) continue;
      if (k === "uid" && depth > 0) continue; // nested uids (e.g. a revision's) are noise
      out[k] = trimNode(val, depth + 1);
    }
    return out;
  }
  return v;
}

// Revision metadata the CLI returns but the old shaping dropped. sha1 is what the
// uploader claimed (unverified) and is absent on most files.
export function revisionMeta(item: Record<string, unknown>): { mtime?: string; uploadedAt?: string; sha1?: string } {
  const rev = item.activeRevision as Record<string, unknown> | undefined;
  if (!rev || typeof rev !== "object") return {};
  const digests = (rev.claimedDigests ?? {}) as Record<string, unknown>;
  const out: { mtime?: string; uploadedAt?: string; sha1?: string } = {};
  if (typeof rev.claimedModificationTime === "string") out.mtime = rev.claimedModificationTime;
  if (typeof rev.creationTime === "string") out.uploadedAt = rev.creationTime;
  if (typeof digests.sha1 === "string") out.sha1 = digests.sha1;
  return out;
}

export function mapPhoto(item: Record<string, unknown>): AlbumPhoto {
  const photo = (item.photo ?? {}) as Record<string, unknown>;
  const captureTime = item.captureTime ?? photo.captureTime;
  const tags = item.tags ?? photo.tags;
  return {
    nodeUid: String(item.nodeUid ?? item.uid ?? ""),
    name: item.name !== undefined ? unwrapResult(item.name) || undefined : undefined,
    mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
    creationTime: typeof item.creationTime === "string" ? item.creationTime : undefined,
    totalStorageSize: typeof item.totalStorageSize === "number" ? item.totalStorageSize : undefined,
    captureTime: typeof captureTime === "string" ? captureTime : undefined,
    tags: Array.isArray(tags) ? tags : undefined,
  };
}

