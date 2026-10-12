// F-02: a download writes names chosen by the REMOTE side, and the closed CLI sanitises nothing.
// Design (fail closed throughout; any error refuses the call and removes the staging directory):
//   1. precheck   - the remote item's own name and the exact local target go through the local path policy.
//   2. enumerate  - a folder is listed in full; every descendant name must be one plain path component.
//                   An incomplete listing refuses (no "best effort").
//   3. stage      - the CLI downloads into a fresh 0700 directory BESIDE the destination (same filesystem),
//                   never into the destination itself.
//   4. validate   - the staged tree is walked with lstat (links are never followed): symlinks, hardlinked
//                   files, FIFOs/sockets/devices, case/normalisation collisions, unsafe names, entry and byte
//                   limits all refuse. Modes are normalised (no setuid/exec bits from the remote side).
//   5. place      - the destination is resolved ONCE (realpath.native), the final targets are re-checked
//                   against the local policy, and entries are moved with rename(2) (copy only on EXDEV).
//                   A failure mid-move rolls back what this call placed.
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, basename } from "node:path";
import { splitRemotePath, unescapeName, type DriveService } from "./drive.js";
import { walkTree } from "./walk.js";
import { assertLocalPathAllowed } from "../utils/localguard.js";
import { showValue } from "../utils/text.js";
import { registerTempDir, unregisterTempDir } from "../utils/tempDirs.js";
import type { DownloadResult, TransferSummary } from "../types/index.js";
import type { DownloadFileStrategy, DownloadFolderStrategy, PhotoDownloadStrategy } from "../policy/strategies.js";

const CONTROL_RE = new RegExp("[\\x00-\\x1f\\x7f\\u2028\\u2029]");
const MAX_VALIDATION_LISTINGS = 2000;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const DEFAULT_MAX_BYTES = 50 * 1024 ** 3;

/** PROTON_DRIVE_DOWNLOAD_MAX_BYTES: most bytes one download call may bring in (default 50 GiB). */
export function downloadMaxBytes(): number {
  const n = Number(process.env["PROTON_DRIVE_DOWNLOAD_MAX_BYTES"]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

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
  return `remotePath: ${showValue(r.remotePath)}\nlocalPath: ${showValue(r.localPath)}\nfileConflictStrategy: ${r.fileStrategy}\nfolderConflictStrategy: ${r.folderStrategy}`;
}
export function describePhotoDownload(r: PhotoDownloadRequest): string {
  return `photoPaths: ${r.remotePaths.slice(0, 5).map((p) => showValue(p)).join(" | ")}${r.remotePaths.length > 5 ? ` (+${r.remotePaths.length - 5} more)` : ""}\nlocalFolder: ${showValue(r.localPath)}\nconflictStrategy: ${r.strategy}`;
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

// ---- 4. validate ----

const foldKey = (n: string): string => n.normalize("NFC").toLowerCase();
const umaskBits = (): number => { const m = process.umask(); return m; };

/** Walks the staged tree without following links. Throws on the first violation. Returns the top-level names. */
export function validateStaged(stageRoot: string): string[] {
  const realRoot = realpathSync.native(stageRoot);
  const mask = umaskBits();
  let entries = 0;
  let bytes = 0;
  const max = downloadMaxBytes();

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error("download refused: folder nesting is too deep");
    const names = readdirSync(dir);
    const seen = new Set<string>();
    for (const n of names) {
      assertSafeEntryName(n, { top: depth === 0 });
      const key = foldKey(n);
      if (seen.has(key)) throw new Error(`download refused: names that differ only by case or Unicode form collide: ${showValue(n)}`);
      seen.add(key);
      if (++entries > MAX_ENTRIES) throw new Error(`download refused: more than ${MAX_ENTRIES} entries`);
      const full = join(dir, n);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`download refused: it contains a symlink (${showValue(n)})`);
      if (st.isDirectory()) {
        chmodSync(full, 0o777 & ~mask & 0o755 | 0o700);
        walk(full, depth + 1);
      } else if (st.isFile()) {
        if (st.nlink > 1) throw new Error(`download refused: ${showValue(n)} is a hardlink`);
        bytes += st.size;
        if (bytes > max) throw new Error(`download refused: more than PROTON_DRIVE_DOWNLOAD_MAX_BYTES (${max}) arrived`);
        chmodSync(full, 0o666 & ~mask & 0o644 | 0o600);
      } else {
        throw new Error(`download refused: ${showValue(n)} is not a regular file or folder (FIFO, socket or device)`);
      }
    }
  };
  walk(realRoot, 0);
  return readdirSync(realRoot);
}

// ---- 5. place ----

interface Counters { placed: number; skipped: number }

function uniqueName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext === name ? "" : ext}`;
    if (!existsSyncNoFollow(join(dir, candidate))) return candidate;
  }
  throw new Error("could not find a free name for the downloaded item");
}

function existsSyncNoFollow(p: string): boolean {
  try { lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

function moveEntry(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    try {
      cpSync(src, dst, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, dereference: false });
    } catch (err) {
      rmSync(dst, { recursive: true, force: true });
      throw err;
    }
    rmSync(src, { recursive: true, force: true });
  }
}

function countFiles(p: string): number {
  const st = lstatSync(p);
  if (!st.isDirectory()) return 1;
  return readdirSync(p).reduce((n, c) => n + countFiles(join(p, c)), 0);
}

function placeEntry(
  src: string, dstDir: string, name: string, fileStrat: string, folderStrat: string, c: Counters, journal: string[],
): void {
  assertSafeEntryName(name);
  const dst = join(dstDir, name);
  const srcIsDir = lstatSync(src).isDirectory();
  if (!existsSyncNoFollow(dst)) {
    moveEntry(src, dst);
    journal.push(dst);
    c.placed++;
    return;
  }
  const dstSt = lstatSync(dst);
  if (dstSt.isSymbolicLink()) throw new Error(`refusing to write through a symlink at ${showValue(dst)}`);
  const strat = srcIsDir && dstSt.isDirectory() ? folderStrat : fileStrat;
  if (strat === "skip") { c.skipped += countFiles(src); return; }
  if (strat === "rename") {
    const alt = uniqueName(dstDir, name);
    moveEntry(src, join(dstDir, alt));
    journal.push(join(dstDir, alt));
    c.placed++;
    return;
  }
  if (strat === "merge") {
    for (const child of readdirSync(src).sort()) placeEntry(join(src, child), dst, child, fileStrat, folderStrat, c, journal);
    return;
  }
  if (strat === "remove") {
    rmSync(dst, { recursive: true, force: true });
    moveEntry(src, dst);
    journal.push(dst);
    c.placed++;
    return;
  }
  throw new Error(`unknown conflict strategy ${showValue(strat)}`);
}

function placeAll(realStage: string, realDest: string, names: string[], fileStrat: string, folderStrat: string): Counters {
  const c: Counters = { placed: 0, skipped: 0 };
  const journal: string[] = [];
  try {
    for (const name of names) {
      assertSafeEntryName(name, { top: true });
      assertLocalPathAllowed(join(realDest, name)); // re-checked on the resolved destination, right before use
      placeEntry(join(realStage, name), realDest, name, fileStrat, folderStrat, c, journal);
    }
  } catch (e) {
    for (const p of journal.reverse()) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort rollback */ }
    }
    throw e;
  }
  return c;
}

async function staged<T>(
  localPath: string, expectTop: string | null, fileStrat: string, folderStrat: string, transfer: (stageDir: string) => Promise<T>,
): Promise<{ result: T; counters: Counters }> {
  ensurePrivateDir(localPath);
  const realDest = realpathSync.native(localPath);
  const stage = makeStaging(realDest);
  try {
    const result = await transfer(stage);
    const names = validateStaged(stage);
    if (expectTop !== null && names.some((n) => n !== expectTop)) {
      throw new Error(`download refused: unexpected entries arrived (${names.filter((n) => n !== expectTop).slice(0, 3).map((n) => showValue(n, 40, 10)).join(", ")})`);
    }
    const counters = placeAll(realpathSync.native(stage), realDest, names, fileStrat, folderStrat);
    return { result, counters };
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); } finally { unregisterTempDir(stage); }
  }
}

/** drive_download / CLI download: validated, staged, placed. The CLI never writes into the destination. */
export async function safeDownload(drive: DriveService, req: Readonly<DownloadRequest>): Promise<DownloadResult> {
  precheckDownload(req.remotePath, req.localPath);
  await enumerateRemote(drive, req.remotePath);
  const expected = unescapeName(splitRemotePath(req.remotePath).name);
  const { result, counters } = await staged(req.localPath, expected, req.fileStrategy, req.folderStrategy, (stage) =>
    drive.download(req.remotePath, stage, req.fileStrategy, req.folderStrategy));
  return {
    ...result,
    localPath: req.localPath,
    downloaded: Math.max(0, result.downloaded - counters.skipped),
    skipped: result.skipped + counters.skipped,
  };
}

/** photos_download / CLI photo download. Photos are single files, so there is nothing to enumerate remotely. */
export async function safePhotoDownload(drive: DriveService, req: Readonly<PhotoDownloadRequest>): Promise<TransferSummary> {
  precheckPhotoDownload(req);
  const { result, counters } = await staged(req.localPath, null, req.strategy, "merge", (stage) =>
    drive.photoDownload([...req.remotePaths], stage, req.strategy));
  return {
    ...result,
    transferredItems: Math.max(0, result.transferredItems - counters.skipped),
    skippedItems: result.skippedItems + counters.skipped,
  };
}
