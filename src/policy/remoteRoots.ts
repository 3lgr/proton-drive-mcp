// Drive roots are structural: they are never the subject of a mutation (trash, move, rename, copy, share...),
// and never a destination other than /my-files. Enforced inside DriveService, so MCP and CLI share it.

/** Confirmed live: `sharing status /my-files` fails; roots are not nodes that can be mutated. */
export const ROOT_PATHS: ReadonlySet<string> = new Set([
  "/my-files", "/photos", "/albums", "/trash", "/photos-trash", "/shared-with-me", "/shared-by-me", "/devices",
]);

/** A single item directly inside /trash or /photos-trash (a literal '/' in a name is written "\/"). */
export const TRASH_ITEM_RE = /^\/(trash|photos-trash)\/(?:[^/\\]|\\.)+$/;

/** Canonical spelling for comparison: single slashes, no trailing slash, lower case. */
function canonical(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, "/");
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  return (trimmed || "/").toLowerCase();
}

export function isRootPath(p: string): boolean {
  const c = canonical(p);
  return c === "/" || ROOT_PATHS.has(c);
}

/** The item itself is the target of a change: it must be below a root. */
export function assertMutablePath(p: string, action: string): void {
  if (isRootPath(p)) throw new Error(`cannot ${action} a Drive root (${p}); pass an item inside it`);
}

/** A folder that receives items: /my-files or anything below a root; no other root. */
export function assertDestinationFolder(p: string, action: string): void {
  const c = canonical(p);
  if (c === "/my-files") return;
  if (isRootPath(p)) throw new Error(`cannot ${action} into the Drive root ${p}; use /my-files or a folder inside it`);
}

/** drive_mkdir: a named root cannot be created ("/" itself gets the service's own "needs a folder name" error). */
export function assertCreatable(p: string): void {
  if (canonical(p) === "/") return;
  assertMutablePath(p, "create");
}
