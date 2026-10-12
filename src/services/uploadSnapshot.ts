// F-04: what the CLI uploads must be exactly what was approved. A pre-scan followed by an upload BY PATH leaves a
// window in which the tree changes (or the CLI sees something the scanner did not). So the tree is validated with
// lstat (links never followed), copied file by file into a private 0700 snapshot, and the CLI uploads the snapshot.
// planUploadSnapshot() is pure; the executor performs only what it returns. Any error refuses the call.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isProtectedEntry } from "../utils/localguard.js";
import { showValue } from "../utils/text.js";
import { registerTempDir, unregisterTempDir } from "../utils/tempDirs.js";

export const MAX_UPLOAD_ENTRIES = 50_000;
const MAX_DEPTH = 64;
const DEFAULT_MAX_BYTES = 5 * 1024 ** 3;

/** PROTON_DRIVE_UPLOAD_MAX_BYTES: most bytes one upload call may snapshot (default 5 GiB); larger is refused. */
export function uploadMaxBytes(): number {
  const n = Number(process.env["PROTON_DRIVE_UPLOAD_MAX_BYTES"]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

export type EntryKind = "file" | "dir" | "symlink" | "other";
export interface ScanNode {
  readonly name: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly nlink: number;
  readonly dev: number;
  readonly children: readonly ScanNode[];
}
export type SnapshotAction =
  | { readonly op: "mkdir"; readonly rel: string }
  | { readonly op: "copy"; readonly rel: string; readonly size: number };

export interface SnapshotLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  /** True for secret-looking or protected entries (relative path from the root, inclusive). */
  readonly isProtected: (rel: string, name: string) => boolean;
}

/** Pure: the exact copy plan for a scanned tree, or an Error naming the first offender. */
export function planUploadSnapshot(root: ScanNode, limits: SnapshotLimits): SnapshotAction[] {
  if (root.kind === "symlink") throw new Error(`refusing to upload a symlink: ${showValue(root.name)}`);
  if (root.kind !== "file" && root.kind !== "dir") throw new Error(`refusing to upload ${showValue(root.name)}: not a regular file or folder`);
  const out: SnapshotAction[] = [];
  let entries = 0;
  let bytes = 0;
  const visit = (n: ScanNode, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error("refusing to upload: folder nesting is too deep");
    if (++entries > limits.maxEntries) throw new Error(`refusing to upload: more than ${limits.maxEntries} entries; upload subfolders separately`);
    if (n.kind === "symlink") throw new Error(`refusing to upload: it contains a symlink (${showValue(rel, 80, 30)})`);
    if (n.kind === "other") throw new Error(`refusing to upload: ${showValue(rel, 80, 30)} is a FIFO, socket or device`);
    if (n.dev !== root.dev) throw new Error(`refusing to upload: ${showValue(rel, 80, 30)} is on another filesystem (mount point)`);
    if (rel !== "" && limits.isProtected(rel, n.name)) throw new Error(`refusing to upload: ${showValue(rel, 80, 30)} is a secret or protected file`);
    if (n.kind === "dir") {
      out.push({ op: "mkdir", rel });
      for (const c of n.children) visit(c, rel === "" ? c.name : `${rel}/${c.name}`, depth + 1);
      return;
    }
    if (n.nlink > 1) throw new Error(`refusing to upload: ${showValue(rel, 80, 30)} is a hardlink`);
    bytes += n.size;
    if (bytes > limits.maxBytes) {
      throw new Error(`refusing to upload: more than ${limits.maxBytes} bytes (PROTON_DRIVE_UPLOAD_MAX_BYTES). The upload is snapshotted before sending; raise the limit or upload parts separately.`);
    }
    out.push({ op: "copy", rel, size: n.size });
  };
  visit(root, "", 0);
  return out;
}

function scanTree(path: string, name: string, budget = { left: MAX_UPLOAD_ENTRIES + 1 }): ScanNode {
  if (--budget.left < 0) throw new Error(`refusing to upload: more than ${MAX_UPLOAD_ENTRIES} entries; upload subfolders separately`);
  const st = lstatSync(path);
  const kind: EntryKind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  const children = kind === "dir" ? readdirSync(path).sort().map((c) => scanTree(join(path, c), c, budget)) : [];
  return { name, kind, size: st.size, nlink: st.nlink, dev: st.dev, children };
}

function limitsFor(root: string): SnapshotLimits {
  return {
    maxEntries: MAX_UPLOAD_ENTRIES,
    maxBytes: uploadMaxBytes(),
    isProtected: (rel, name) => isProtectedEntry(join(root, ...rel.split("/")), name),
  };
}

/** Scan + plan without copying anything (cheap early refusal, before a human is asked). Throws on any problem. */
export function precheckUpload(localPath: string): void {
  planUploadSnapshot(scanTree(localPath, basename(localPath)), limitsFor(localPath));
}

async function copyRegular(src: string, dst: string, expectedSize: number): Promise<void> {
  // O_NOFOLLOW + fstat on the descriptor we read from: a file swapped for a link or another file after the scan is caught here.
  const fd = openSync(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw new Error(`refusing to upload: ${showValue(src, 80, 30)} changed type while it was being copied`);
    if (st.size !== expectedSize) throw new Error(`refusing to upload: ${showValue(src, 80, 30)} changed size while it was being copied`);
    const input = createReadStream(src, { fd, autoClose: false, start: 0, end: Math.max(0, st.size - 1) });
    if (st.size > 0) await pipeline(input, createWriteStream(dst, { flags: "wx", mode: 0o600 }));
    else await pipeline([], createWriteStream(dst, { flags: "wx", mode: 0o600 }));
    utimesSync(dst, st.atime, st.mtime); // Drive keeps the original modification time
  } finally {
    closeSync(fd);
  }
}

/**
 * Snapshots every path into a private staging directory and runs `fn` with the snapshot paths (same order, same
 * base names). The staging directory is always removed. Nothing is passed to `fn` unless every path was accepted.
 */
export async function withUploadSnapshot<T>(localPaths: readonly string[], fn: (snapshotPaths: string[]) => Promise<T>): Promise<T> {
  const stage = mkdtempSync(join(tmpdir(), "pdmcp-upload-"));
  registerTempDir(stage);
  try {
    const out: string[] = [];
    let total = 0;
    for (let i = 0; i < localPaths.length; i++) {
      const src = localPaths[i] as string;
      const limits = limitsFor(src);
      const actions = planUploadSnapshot(scanTree(src, basename(src)), { ...limits, maxBytes: Math.max(0, limits.maxBytes - total) });
      const holder = join(stage, String(i));
      mkdirSync(holder, { mode: 0o700 });
      const dst = join(holder, basename(src));
      for (const a of actions) {
        const target = a.rel === "" ? dst : join(dst, ...a.rel.split("/"));
        const from = a.rel === "" ? src : join(src, ...a.rel.split("/"));
        if (a.op === "mkdir") mkdirSync(target, { mode: 0o700 });
        else { await copyRegular(from, target, a.size); total += a.size; }
      }
      out.push(dst);
    }
    return await fn(out);
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); } finally { unregisterTempDir(stage); }
  }
}
