// N-01: is a destination visible to other people? One answer for every tool that puts data somewhere
// (move, copy, bulk move, upload, add to album), so the rule cannot drift between them.
//
//   - strict policy only: with PROTON_DRIVE_SHARE_POLICY=off nothing is looked up
//   - the destination AND every ancestor up to (not including) the root are checked, because a folder inside a
//     shared folder is visible to its members even though it has no invitation of its own
//   - a lookup that fails is NOT "not shared": it fails closed (shared, unverified), so the human is asked
//   - an item that does not exist yet cannot be shared itself: only its ancestors decide
import { splitRemotePath, unescapeName } from "../services/driveShape.js";
import { isRootPath } from "./remoteRoots.js";
import type { SharePolicy } from "./sharePolicy.js";

export interface ShareLookup {
  shareStatus(path: string): Promise<{ readonly isShared: boolean }>;
}

export interface DestinationShare {
  /** Treat the destination as visible to other people (shared, or not known to be private). */
  readonly shared: boolean;
  /** True when `shared` is only because a lookup failed; the prompt must say so. */
  readonly unverified: boolean;
}

export const PRIVATE_DESTINATION: DestinationShare = { shared: false, unverified: false };
const SHARED: DestinationShare = { shared: true, unverified: false };
const UNVERIFIED: DestinationShare = { shared: true, unverified: true };

/** Per-call memo: the same ancestor is asked once even when several destinations (bulk) share it. */
export type ShareCache = Map<string, Promise<"shared" | "private" | "missing" | "unknown">>;

const VIRTUAL_SHARED = /^\/(shared-with-me|shared-by-me)\/./i;
const NOT_FOUND = /\[NOT_FOUND\]|not found/i;

function lookupOne(drive: ShareLookup, path: string, cache: ShareCache): Promise<"shared" | "private" | "missing" | "unknown"> {
  const known = cache.get(path);
  if (known) return known;
  const pending = drive.shareStatus(path).then(
    (s) => (s.isShared ? "shared" : "private") as "shared" | "private",
    (e: unknown) => ((NOT_FOUND.test(e instanceof Error ? e.message : "") ? "missing" : "unknown") as "missing" | "unknown"),
  );
  cache.set(path, pending);
  return pending;
}

export async function destinationShare(
  drive: ShareLookup, policy: SharePolicy, folder: string, cache: ShareCache = new Map(),
): Promise<DestinationShare> {
  if (policy.mode === "off") return PRIVATE_DESTINATION;
  // Items under these virtual roots are shared by definition (they exist because of a share).
  if (VIRTUAL_SHARED.test(folder)) return SHARED;
  let current = folder;
  for (let depth = 0; depth < 256 && !isRootPath(current); depth++) {
    const state = await lookupOne(drive, current, cache);
    if (state === "shared") return SHARED;
    if (state === "unknown") return UNVERIFIED;
    const parent = splitRemotePath(current).parent;
    if (parent === current) break;
    current = parent;
  }
  return PRIVATE_DESTINATION;
}

export interface AlbumLookup { listAlbums(): Promise<readonly { readonly name: string; readonly isShared: boolean }[]> }

/**
 * An album is a single node: shared or not (no ancestors). A name that cannot be matched, an ambiguous name or a
 * failed listing is "could not be verified" (fail closed), never "private".
 */
export async function albumShare(drive: AlbumLookup, policy: SharePolicy, albumPath: string): Promise<DestinationShare> {
  if (policy.mode === "off") return PRIVATE_DESTINATION;
  try {
    const name = unescapeName(albumPath.replace(/^\/albums\//, ""));
    const matches = (await drive.listAlbums()).filter((a) => a.name === name);
    if (matches.length !== 1) return UNVERIFIED;
    return matches[0]!.isShared ? SHARED : PRIVATE_DESTINATION;
  } catch { return UNVERIFIED; }
}

/** The sentence appended to an approval prompt; empty when the destination is private. */
export function sharedDestinationNote(s: DestinationShare): string {
  if (!s.shared) return "";
  return s.unverified
    ? "\nWARNING: the sharing state of the destination could not be verified; it may be visible to other people."
    : "\nWARNING: the destination is already shared with other people (it is, or sits inside, a shared folder or album); they will see these items.";
}
