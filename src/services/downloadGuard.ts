// F-02: a download writes names chosen by the REMOTE side, and the closed CLI sanitises nothing.
// Fail closed throughout: any error refuses the call, promotes nothing and removes the staging directory.
//   1. precheck   - the item's own name and the exact local target go through the local path policy.
//   2. enumerate  - a folder is listed in full; every descendant name must be one plain path component.
//   3. stage      - the CLI downloads into a fresh 0700 directory BESIDE the destination, never into it.
//   4. scan       - lstat only (links are never followed): names, collisions, hardlinks, limits; modes normalised.
//   5. plan       - planDownload() (pure, downloadPlan.ts) returns the exact allowed actions or throws.
//   6. execute    - only those actions run, on the destination resolved once with realpath.native; files move
//                   with link(2) so nothing is ever overwritten; a failure rolls back what this call placed.
import {
  chmodSync, constants, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync,
  rmSync, rmdirSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { splitRemotePath, unescapeName, type DriveService } from "./drive.js";
import { walkTree } from "./walk.js";
import { assertLocalPathAllowed } from "../utils/localguard.js";
import { showValue } from "../utils/text.js";
import { approvalField } from "../policy/untrusted.js";
import { registerTempDir, unregisterTempDir } from "../utils/tempDirs.js";
import type { DownloadResult, TransferSummary } from "../types/index.js";
import type { DownloadFileStrategy, DownloadFolderStrategy, PhotoDownloadStrategy } from "../policy/strategies.js";
import { assertSafeEntryName, planDownload, type Action, type Existing, type Policy, type StagedNode } from "./downloadPlan.js";

export { assertSafeEntryName };

const MAX_VALIDATION_LISTINGS = 2000;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const DEFAULT_MAX_BYTES = 50 * 1024 ** 3;

/** PROTON_DRIVE_DOWNLOAD_MAX_BYTES: most bytes one download call may bring in (default 50 GiB). */
export function downloadMaxBytes(): number {
  const n = Number(process.env["PROTON_DRIVE_DOWNLOAD_MAX_BYTES"]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
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

// ---- frozen requests: the object that is validated, shown to the human and executed is one and the same ----

export interface DownloadRequest {
  readonly remotePath: string;
  readonly localPath: string;
  readonly fileStrategy: DownloadFileStrategy;
  readonly folderStrategy: DownloadFolderStrategy;
}
export interface PhotoDownloadRequest {
  readonly remotePaths: readonly string[];
  readonly localPath: string;
  readonly strategy: PhotoDownloadStrategy;
}

export const freezeDownload = (r: DownloadRequest): Readonly<DownloadRequest> => Object.freeze({ ...r });
export const freezePhotoDownload = (r: PhotoDownloadRequest): Readonly<PhotoDownloadRequest> =>
  Object.freeze({ ...r, remotePaths: Object.freeze([...r.remotePaths]) });

export function describeDownload(r: DownloadRequest): string {
  return `remotePath: ${approvalField(r.remotePath)}\nlocalPath: ${approvalField(r.localPath)}\nfileConflictStrategy: ${r.fileStrategy}\nfolderConflictStrategy: ${r.folderStrategy}`;
}
export function describePhotoDownload(r: PhotoDownloadRequest): string {
  return `${r.remotePaths.map((p, i) => `photoPaths[${i}]: ${approvalField(p)}`).join("\n")}\nlocalFolder: ${approvalField(r.localPath)}\nconflictStrategy: ${r.strategy}`;
}

// ---- 1. precheck (no CLI call) ----

function assertNotLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing to download onto a symlink: ${showValue(path)}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Name and final target of one remote item. Returns the target path. */
export function precheckDownload(remotePath: string, localPath: string): string {
  const name = unescapeName(splitRemotePath(remotePath).name);
  assertSafeEntryName(name, { top: true });
  const target = join(localPath, name);
  assertLocalPathAllowed(target);
  assertNotLink(target);
  return target;
}

export function precheckPhotoDownload(r: PhotoDownloadRequest): void {
  for (const p of r.remotePaths) precheckDownload(p, r.localPath);
}

// ---- 2. enumerate ----

async function enumerateRemote(drive: DriveService, remotePath: string): Promise<void> {
  const node = (await drive.info(remotePath)) as { type?: unknown; activeRevision?: { claimedSize?: unknown } } | null;
  const isFile = node !== null && !Array.isArray(node) && typeof node === "object" && node.type === "file";
  if (isFile) {
    const size = node.activeRevision?.claimedSize;
    if (typeof size === "number" && size > downloadMaxBytes()) throw new Error(`refusing: the item is ${size} bytes, over PROTON_DRIVE_DOWNLOAD_MAX_BYTES (${downloadMaxBytes()})`);
    return;
  }
  const walk = await walkTree(drive, remotePath, { exclude: [], refresh: true, noDisk: true, budgetMs: 0, maxCalls: MAX_VALIDATION_LISTINGS });
  if (!walk.complete) {
    throw new Error(
      `the remote folder could not be fully listed (${walk.skipped.length} folder(s) skipped or over the ${MAX_VALIDATION_LISTINGS}-folder validation limit), ` +
      "so its entries cannot be validated before download. Download its subfolders separately.",
    );
  }
  let total = 0;
  for (const n of walk.nodes) {
    for (const part of relativeNames(walk.root, n.path)) assertSafeEntryName(part);
    total += typeof n.size === "number" ? n.size : 0;
  }
  if (walk.nodes.length > MAX_ENTRIES) throw new Error(`refusing: the folder holds more than ${MAX_ENTRIES} entries; download subfolders separately`);
  if (total > downloadMaxBytes()) throw new Error(`refusing: the folder is ${total} bytes, over PROTON_DRIVE_DOWNLOAD_MAX_BYTES (${downloadMaxBytes()})`);
}

// ---- 3. staging ----

function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** A fresh 0700 directory beside `realDest` (same filesystem => atomic rename), else in the OS temp dir. */
function makeStaging(realDest: string): string {
  let dir: string;
  try { dir = mkdtempSync(join(dirname(realDest), ".pdmcp-stage-")); }
  catch { dir = mkdtempSync(join(tmpdir(), "pdmcp-stage-")); }
  chmodSync(dir, 0o700);
  registerTempDir(dir);
  return dir;
}

// ---- 4. scan the staged tree (lstat only, links are never followed) ----

const umaskBits = (): number => process.umask();

/** Builds the description of what arrived. Limits and hardlinks throw here; everything else is judged by planDownload. */
export function scanStaged(stageRoot: string): StagedNode[] {
  const mask = umaskBits();
  let entries = 0;
  let bytes = 0;
  const max = downloadMaxBytes();

  const scan = (dir: string, depth: number): StagedNode[] => {
    if (depth > MAX_DEPTH) throw new Error("download refused: folder nesting is too deep");
    const out: StagedNode[] = [];
    const seen = new Set<string>();
    for (const name of readdirSync(dir).sort()) {
      assertSafeEntryName(name);
      const key = name.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw new Error(`download refused: names that differ only by case or Unicode form collide: ${showValue(name)}`);
      seen.add(key);
      if (++entries > MAX_ENTRIES) throw new Error(`download refused: more than ${MAX_ENTRIES} entries`);
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) { out.push({ name, kind: "symlink", children: [], files: 0 }); continue; }
      if (st.isDirectory()) {
        chmodSync(full, (0o777 & ~mask & 0o755) | 0o700);
        const children = scan(full, depth + 1);
        out.push({ name, kind: "dir", children, files: children.reduce((n, c) => n + c.files, 0) });
      } else if (st.isFile()) {
        if (st.nlink > 1) throw new Error(`download refused: ${showValue(name)} is a hardlink`);
        bytes += st.size;
        if (bytes > max) throw new Error(`download refused: more than PROTON_DRIVE_DOWNLOAD_MAX_BYTES (${max}) arrived`);
        chmodSync(full, (0o666 & ~mask & 0o644) | 0o600);
        out.push({ name, kind: "file", children: [], files: 1 });
      } else {
        out.push({ name, kind: "other", children: [], files: 0 });
      }
    }
    return out;
  };
  return scan(stageRoot, 0);
}

// ---- 5. execute exactly the plan ----

function kindOf(p: string): Existing | undefined {
  let st;
  try { st = lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  if (st.isSymbolicLink()) return { kind: "symlink" };
  if (st.isDirectory()) return { kind: "dir", empty: readdirSync(p).length === 0 };
  if (st.isFile()) return { kind: "file" };
  return { kind: "other" };
}

/** Moves one file without ever overwriting: link(2) fails with EEXIST, so a late-appearing target is an error. */
function placeFile(src: string, dst: string): void {
  try {
    linkSync(src, dst);
    unlinkSync(src);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    unlinkSync(src);
  }
}

function placeDir(src: string, dst: string): void {
  try {
    renameSync(src, dst); // fails on a non-empty existing directory; never merges
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(src, dst, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    rmSync(src, { recursive: true, force: true });
  }
}

function execute(stage: string, dest: string, actions: readonly Action[]): { skipped: number } {
  let skipped = 0;
  const placed: string[] = [];
  try {
    for (const a of actions) {
      if (a.op === "skip") { skipped += a.files; continue; }
      const dst = join(dest, ...a.dstRel.split("/"));
      if (a.op === "unlink") { if (kindOf(dst)?.kind !== "file") throw new Error("download refused: the local target changed type"); unlinkSync(dst); continue; }
      if (a.op === "rmdir") { rmdirSync(dst); continue; }
      const src = join(stage, ...a.srcRel.split("/"));
      if (a.kind === "file") placeFile(src, dst); else placeDir(src, dst);
      placed.push(dst);
    }
  } catch (e) {
    for (const p of placed.reverse()) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort rollback */ }
    }
    throw e;
  }
  return { skipped };
}

async function staged<T>(
  localPath: string, expectTop: string | null, policy: Policy, transfer: (stageDir: string) => Promise<T>, transient = false,
  onStaging?: (stageDir: string) => void,
): Promise<{ result: T; skipped: number }> {
  ensurePrivateDir(localPath);
  const realDest = realpathSync.native(localPath);
  const stage = makeStaging(realDest);
  onStaging?.(stage);
  try {
    const result = await transfer(stage);
    const realStage = realpathSync.native(stage);
    const top = scanStaged(realStage);
    if (expectTop !== null && top.some((n) => n.name !== expectTop)) {
      throw new Error(`download refused: unexpected entries arrived (${top.filter((n) => n.name !== expectTop).slice(0, 3).map((n) => showValue(n.name, 40, 10)).join(", ")})`);
    }
    if (!transient) for (const n of top) assertLocalPathAllowed(join(realDest, n.name)); // on the resolved destination, right before use
    const actions = planDownload(top, (rel) => kindOf(join(realDest, ...rel.split("/"))), policy);
    if (!transient) {
      // Every path that will be created or replaced goes through the local path policy, descendants of a merge included.
      for (const a of actions) if (a.op === "place") assertLocalPathAllowed(join(realDest, ...a.dstRel.split("/")));
    }
    return { result, ...execute(realStage, realDest, actions) };
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); } finally { unregisterTempDir(stage); }
  }
}

export interface SafeDownloadOptions {
  /**
   * The destination is a private temp directory of this server (content reads, duplicate verification) and the item
   * is a single file the caller has already inspected: the local path policy and the leading-dot rule do not apply,
   * but the name check, staging, scan and plan still do. The CLI still never writes into the destination.
   */
  transient?: boolean;
  /** Called with the staging directory as soon as it exists (so a caller can watch its size while the CLI writes). */
  onStaging?: (stageDir: string) => void;
}

/** drive_download / CLI download: validated, staged, placed. The CLI never writes into the destination. */
export async function safeDownload(drive: DriveService, req: Readonly<DownloadRequest>, opts: SafeDownloadOptions = {}): Promise<DownloadResult> {
  if (opts.transient) {
    assertSafeEntryName(unescapeName(splitRemotePath(req.remotePath).name));
  } else {
    precheckDownload(req.remotePath, req.localPath);
    await enumerateRemote(drive, req.remotePath);
  }
  const expected = unescapeName(splitRemotePath(req.remotePath).name);
  const { result, skipped } = await staged(req.localPath, opts.transient ? null : expected, { file: req.fileStrategy, folder: req.folderStrategy }, (stage) =>
    drive.download(req.remotePath, stage, req.fileStrategy, req.folderStrategy), opts.transient === true, opts.onStaging);
  return { ...result, localPath: req.localPath, downloaded: Math.max(0, result.downloaded - skipped), skipped: result.skipped + skipped };
}

/** photos_download / CLI photo download. Photos are single files, so there is nothing to enumerate remotely. */
export async function safePhotoDownload(drive: DriveService, req: Readonly<PhotoDownloadRequest>): Promise<TransferSummary> {
  precheckPhotoDownload(req);
  const { result, skipped } = await staged(req.localPath, null, { file: req.strategy, folder: "skip" }, (stage) =>
    drive.photoDownload([...req.remotePaths], stage, req.strategy));
  return { ...result, transferredItems: Math.max(0, result.transferredItems - skipped), skippedItems: result.skippedItems + skipped };
}
