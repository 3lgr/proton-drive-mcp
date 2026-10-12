// F-02: a download writes names chosen by the REMOTE side. Validating only the destination folder let a
// remote item named ".ssh" (or "../../x", via a literal '/' in a node name) land in a protected place.
// Before any byte is written every name that will be created is checked against the local policy; after the
// transfer the new entries are scanned again. The closed CLI is not asked to sanitise anything.
import { lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync, existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { splitRemotePath, unescapeName, type DriveService } from "./drive.js";
import { walkTree } from "./walk.js";
import { assertLocalPathAllowed } from "../utils/localguard.js";
import { showValue } from "../utils/text.js";

const CONTROL_RE = new RegExp("[\\x00-\\x1f\\x7f\\u2028\\u2029]");
/** Folders a pre-download validation walk may list. Past this the download is refused, never waved through. */
const MAX_VALIDATION_LISTINGS = 2000;
const MAX_SNAPSHOT_ENTRIES = 100_000;

export interface EntryNameOptions { top?: boolean }

/** Throws unless `name` is one plain path component. `top` additionally refuses leading-dot names. */
export function assertSafeEntryName(name: string, opts: EntryNameOptions = {}): void {
  if (name === "") throw new Error("unsafe entry name: empty name");
  if (name === "." || name === "..") throw new Error(`unsafe entry name: ${showValue(name)}`);
  if (name.includes("/") || name.includes("\\")) throw new Error(`unsafe entry name (contains a path separator): ${showValue(name)}`);
  if (CONTROL_RE.test(name)) throw new Error(`unsafe entry name (control characters): ${showValue(name)}`);
  if (opts.top && name.startsWith(".")) {
    throw new Error(`refusing to download an item whose name starts with '.': ${showValue(name)}. Dotfiles and dot-folders can configure the local machine (shell, ssh, git); rename the item in Drive first.`);
  }
}

/** The unescaped name components of `path` below `root` ("\/" is a literal slash inside one name). */
function relativeNames(root: string, path: string): string[] {
  const rest = root === "/" ? path.slice(1) : path.slice(root.length + 1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "/" && rest[i - 1] !== "\\") { out.push(cur); cur = ""; } else cur += rest[i];
  }
  out.push(cur);
  return out.map(unescapeName);
}

export interface DownloadPlan {
  readonly destination: string;
  /** Where the item will appear: <destination>/<name>. */
  readonly target: string;
  /** Entries that already existed under `target` (null: too many to snapshot, so no post-scan). */
  readonly before: ReadonlySet<string> | null;
}

/** Relative paths of everything under `root`, without following links. */
function snapshot(root: string): ReadonlySet<string> | null {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const full = join(dir, n);
      seen.add(relative(root, full));
      if (seen.size > MAX_SNAPSHOT_ENTRIES) return null;
      try { if (lstatSync(full).isDirectory()) stack.push(full); } catch { /* vanished */ }
    }
  }
  return seen;
}

function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function assertNotLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing to download onto a symlink: ${showValue(path)}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** The checks that need no CLI call: the item's own name and the exact local file it would become. */
export function precheckDownload(remotePath: string, localPath: string): string {
  const name = unescapeName(splitRemotePath(remotePath).name);
  assertSafeEntryName(name, { top: true });
  const target = join(localPath, name);
  assertLocalPathAllowed(target);
  assertNotLink(target);
  return target;
}

/** Validates everything a folder/file download will write. Throws before the transfer starts. */
export async function guardDownload(drive: DriveService, remotePath: string, localPath: string): Promise<DownloadPlan> {
  const target = precheckDownload(remotePath, localPath);

  const node = (await drive.info(remotePath)) as { type?: unknown } | null;
  const type = node && !Array.isArray(node) ? node.type : undefined;
  if (type !== "file") {
    // Folder (or unknown): list every descendant now, so a name chosen by the remote side cannot surprise us later.
    const walk = await walkTree(drive, remotePath, { exclude: [], refresh: true, noDisk: true, budgetMs: 0, maxCalls: MAX_VALIDATION_LISTINGS });
    if (!walk.complete) {
      throw new Error(
        `the remote folder could not be fully listed (${walk.skipped.length} folder(s) skipped or over the ${MAX_VALIDATION_LISTINGS}-folder validation limit), ` +
        "so its entries cannot be validated before download. Download its subfolders separately.",
      );
    }
    for (const n of walk.nodes) for (const part of relativeNames(walk.root, n.path)) assertSafeEntryName(part);
  }

  ensurePrivateDir(localPath);
  return { destination: localPath, target, before: existsSync(target) ? snapshot(target) : new Set() };
}

/** Scans what the download created. A symlink it left behind is removed; any other violation fails the call. */
export function verifyDownloaded(plan: DownloadPlan): void {
  if (plan.before === null || !existsSync(plan.target)) return;
  const realDest = realpathSync(plan.destination);
  const realTarget = realpathSync(plan.target);
  const inside = relative(realDest, realTarget);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`the download resolved outside the destination folder: ${showValue(plan.target)}`);
  }
  const problems: string[] = [];
  const removed: string[] = [];
  const stack = [plan.target];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const n of entries) {
      const full = join(dir, n);
      const rel = relative(plan.target, full);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (plan.before.has(rel)) {
        if (st.isDirectory()) stack.push(full);
        continue;
      }
      if (st.isSymbolicLink()) {
        try { unlinkSync(full); removed.push(rel); } catch { problems.push(`${rel} (symlink, could not be removed)`); }
        continue;
      }
      try { assertSafeEntryName(n); } catch { problems.push(`${rel} (unsafe name)`); }
      if (st.isDirectory()) stack.push(full);
    }
  }
  if (removed.length || problems.length) {
    const parts = [
      removed.length ? `removed ${removed.length} symlink(s) the download created: ${removed.slice(0, 5).map((r) => showValue(r, 60, 20)).join(", ")}` : "",
      problems.length ? `unsafe entries: ${problems.slice(0, 5).map((r) => showValue(r, 60, 20)).join(", ")}` : "",
    ].filter(Boolean);
    throw new Error(`download finished but violated the local policy (${parts.join("; ")}). Treat the downloaded folder as untrusted.`);
  }
}

/** Photos are flat files: validate each name, then scan the folder for links the CLI added. */
export function guardPhotoDownload(remotePaths: readonly string[], folder: string): { folder: string; before: ReadonlySet<string> | null } {
  for (const p of remotePaths) {
    const name = unescapeName(splitRemotePath(p).name);
    assertSafeEntryName(name, { top: true });
    const target = join(folder, name);
    assertLocalPathAllowed(target);
    assertNotLink(target);
  }
  const before = existsSync(folder) ? snapshot(folder) : new Set<string>();
  ensurePrivateDir(folder);
  return { folder, before };
}

export function verifyPhotoDownload(g: { folder: string; before: ReadonlySet<string> | null }): void {
  verifyDownloaded({ destination: g.folder, target: g.folder, before: g.before });
}
