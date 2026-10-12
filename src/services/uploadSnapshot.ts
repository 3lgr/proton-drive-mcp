// F-04: what the CLI uploads must be exactly what was approved. A pre-scan followed by an upload BY PATH leaves a
// window in which the tree changes (or the CLI sees something the scanner did not). So the tree is validated with
// lstat (links never followed), copied file by file into a private 0700 snapshot, and the CLI uploads the snapshot.
// planUploadSnapshot() is pure; the executor performs only what it returns. Any error refuses the call.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, utimesSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import { isProtectedEntry } from "../utils/localguard.js";
import { showValue } from "../utils/text.js";
import { unregisterTempDir, removeTreeSafe } from "../utils/tempDirs.js";
import { createOwnedTemp } from "../utils/privateTemp.js";

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
  readonly ino: number;
  readonly mtimeMs: number;
  readonly children: readonly ScanNode[];
}
export type SnapshotAction =
  | { readonly op: "mkdir"; readonly rel: string }
  | { readonly op: "copy"; readonly rel: string; readonly size: number; readonly dev: number; readonly ino: number; readonly mtimeMs: number };

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
    out.push({ op: "copy", rel, size: n.size, dev: n.dev, ino: n.ino, mtimeMs: n.mtimeMs });
  };
  visit(root, "", 0);
  return out;
}

function scanTree(path: string, name: string, budget = { left: MAX_UPLOAD_ENTRIES + 1 }): ScanNode {
  if (--budget.left < 0) throw new Error(`refusing to upload: more than ${MAX_UPLOAD_ENTRIES} entries; upload subfolders separately`);
  const st = lstatSync(path);
  const kind: EntryKind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  const children = kind === "dir" ? readdirSync(path).sort().map((c) => scanTree(join(path, c), c, budget)) : [];
  return { name, kind, size: st.size, nlink: st.nlink, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, children };
}

function limitsFor(root: string): SnapshotLimits {
  return {
    maxEntries: MAX_UPLOAD_ENTRIES,
    maxBytes: uploadMaxBytes(),
    isProtected: (rel, name) => isProtectedEntry(join(root, ...rel.split("/")), name),
  };
}

/** Scan + plan without copying anything (early refusal, before a human is asked). The returned plan is the manifest that is approved. */
export function precheckUpload(localPath: string): SnapshotAction[] {
  return planUploadSnapshot(scanTree(localPath, basename(localPath)), limitsFor(localPath));
}

interface CopiedFile { readonly dst: string; readonly size: number; readonly dev: number; readonly ino: number; readonly mtimeMs: number; readonly sha256: string }

/**
 * Copies one regular file. The source is opened O_NOFOLLOW and judged by fstat on that very descriptor: it must
 * still be the file that was scanned (same dev:ino, size, mtime) - an intermediate directory swapped for a link
 * lands on a different inode and is caught here. The copy is created O_EXCL inside the private staging directory.
 */
async function copyRegular(src: string, dst: string, planned: Extract<SnapshotAction, { op: "copy" }>): Promise<CopiedFile> {
  const fd = openSync(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw new Error(`refusing to upload: ${showValue(planned.rel, 80, 30)} changed type while it was being copied`);
    if (st.dev !== planned.dev || st.ino !== planned.ino || st.size !== planned.size || st.mtimeMs !== planned.mtimeMs) {
      throw new Error(`refusing to upload: ${showValue(planned.rel, 80, 30)} changed after it was scanned`);
    }
    const hash = createHash("sha256");
    const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
    const out = createWriteStream(dst, { flags: "wx", mode: 0o600 });
    if (st.size > 0) await pipeline(createReadStream(src, { fd, autoClose: false, start: 0, end: st.size - 1 }), tap, out);
    else await pipeline([], tap, out);
    utimesSync(dst, st.atime, st.mtime); // Drive keeps the original modification time
    const done = lstatSync(dst);
    return { dst, size: done.size, dev: done.dev, ino: done.ino, mtimeMs: done.mtimeMs, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (st.size > 0) for await (const chunk of createReadStream(path, { fd, autoClose: false, start: 0, end: st.size - 1 })) h.update(chunk as Buffer);
  } finally { closeSync(fd); }
  return h.digest("hex");
}

/** Immediately before the CLI is started: the snapshot must still be exactly what was copied, nothing more or less. */
async function verifySnapshot(holder: string, name: string, actions: readonly SnapshotAction[], copied: ReadonlyMap<string, CopiedFile>): Promise<ManifestFile[]> {
  const top = readdirSync(holder);
  if (top.length !== 1 || top[0] !== name) throw new Error("refusing to upload: the snapshot was modified (unexpected top-level entries)");
  if (actions.some((a) => a.op === "mkdir" && a.rel === "")) {
    const expected = new Set(actions.filter((a) => a.rel !== "").map((a) => a.rel));
    const walk = (dir: string, rel: string): void => {
      for (const n of readdirSync(dir)) {
        const r = rel === "" ? n : `${rel}/${n}`;
        if (!expected.delete(r)) throw new Error(`refusing to upload: the snapshot was modified (unexpected entry ${showValue(r, 80, 30)})`);
        if (lstatSync(join(dir, n)).isDirectory()) walk(join(dir, n), r);
      }
    };
    walk(join(holder, name), "");
    if (expected.size > 0) throw new Error("refusing to upload: the snapshot was modified (entries are missing)");
  }
  const fresh: ManifestFile[] = [];
  for (const [rel, c] of copied) {
    const st = lstatSync(c.dst);
    if (!st.isFile() || st.nlink !== 1 || st.size !== c.size || st.dev !== c.dev || st.ino !== c.ino || st.mtimeMs !== c.mtimeMs) {
      throw new Error(`refusing to upload: the snapshot was modified (${showValue(rel, 80, 30)})`);
    }
    const sha256 = await sha256File(c.dst);
    if (sha256 !== c.sha256) throw new Error(`refusing to upload: the snapshot was modified (${showValue(rel, 80, 30)} content)`);
    fresh.push({ rel, size: c.size, sha256 });
  }
  return fresh;
}

export interface ManifestFile { readonly rel: string; readonly size: number; readonly sha256: string }
export interface UploadManifest {
  readonly files: number;
  readonly bytes: number;
  /** sha256 over the ordered (path, size, sha256) list of every snapshotted file, one set per uploaded path. */
  readonly digest: string;
}

/** Deterministic digest of the frozen content: what is approved is exactly this, nothing else. */
export function manifestOf(perPath: readonly (readonly ManifestFile[])[]): UploadManifest {
  const h = createHash("sha256");
  let files = 0;
  let bytes = 0;
  perPath.forEach((list, i) => {
    for (const f of [...list].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
      h.update(`${i}\0${f.rel}\0${f.size}\0${f.sha256}\n`);
      files++;
      bytes += f.size;
    }
  });
  return { files, bytes, digest: h.digest("hex") };
}

/** Makes the snapshot read-only (files 0400, folders 0500) so that nothing changes it quietly after approval. */
function freeze(root: string): void {
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n)); chmodSync(p, 0o500); }
    else if (st.isFile()) chmodSync(p, 0o400);
  };
  walk(root);
}

export interface SnapshotOptions {
  /** Plans (manifests) returned by precheckUpload, one per path: the fresh scan must match them exactly. */
  approved?: readonly (readonly SnapshotAction[])[];
  /**
   * Called once the snapshot is complete, frozen and summarised, before anything is sent. Throw to refuse. The
   * snapshot is re-hashed after this returns, so whatever happens while a human decides cannot slip through.
   */
  approve?: (manifest: UploadManifest) => Promise<void>;
  /** Test seams (fault injection): run after the scan, before each copy / right before `fn`. */
  hooks?: { beforeCopy?: (rel: string, source: string) => void; beforeSpawn?: (snapshotPaths: readonly string[]) => void };
}

const sameAction = (a: SnapshotAction, b: SnapshotAction): boolean =>
  a.op === b.op && a.rel === b.rel &&
  (a.op === "mkdir" || (b.op === "copy" && a.size === b.size && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs));

/**
 * Snapshots every path into a private staging directory and runs `fn` with the snapshot paths (same order, same
 * base names). The staging directory is always removed. `fn` only runs if every path was accepted, matches the
 * approved manifest, and the snapshot still verifies right before the call.
 */
export async function withUploadSnapshot<T>(
  localPaths: readonly string[], fn: (snapshotPaths: string[]) => Promise<T>, opts: SnapshotOptions = {},
): Promise<T> {
  const owned = createOwnedTemp("pdmcp-upload-");
  const stage = owned.work;
  try {
    const out: string[] = [];
    const verifiers: Array<() => Promise<ManifestFile[]>> = [];
    let total = 0;
    for (let i = 0; i < localPaths.length; i++) {
      const src = localPaths[i] as string;
      const limits = limitsFor(src);
      const actions = planUploadSnapshot(scanTree(src, basename(src)), { ...limits, maxBytes: Math.max(0, limits.maxBytes - total) });
      const approved = opts.approved?.[i];
      if (approved && (approved.length !== actions.length || approved.some((a, k) => !sameAction(a, actions[k] as SnapshotAction)))) {
        throw new Error(`refusing to upload ${showValue(src, 80, 30)}: it changed after it was approved`);
      }
      const holder = join(stage, String(i));
      mkdirSync(holder, { mode: 0o700 });
      const dst = join(holder, basename(src));
      const copied = new Map<string, CopiedFile>();
      for (const a of actions) {
        const target = a.rel === "" ? dst : join(dst, ...a.rel.split("/"));
        const from = a.rel === "" ? src : join(src, ...a.rel.split("/"));
        if (a.op === "mkdir") { mkdirSync(target, { mode: 0o700 }); continue; }
        opts.hooks?.beforeCopy?.(a.rel, from);
        copied.set(a.rel, await copyRegular(from, target, a));
        total += a.size;
      }
      verifiers.push(() => verifySnapshot(holder, basename(src), actions, copied));
      out.push(dst);
    }
    // Freeze, summarise, let the caller (human/policy) approve THAT manifest, then recompute and compare.
    const frozen = manifestOf(await Promise.all(verifiers.map((v) => v())));
    freeze(stage);
    if (opts.approve) await opts.approve(frozen);
    opts.hooks?.beforeSpawn?.(out);
    const again = manifestOf(await Promise.all(verifiers.map((v) => v())));
    if (again.digest !== frozen.digest || again.files !== frozen.files || again.bytes !== frozen.bytes) {
      throw new Error("refusing to upload: the snapshot changed after it was approved; ask for approval again");
    }
    return await fn(out);
  } finally {
    try { removeTreeSafe(owned.root); } catch { /* shutdown removes the whole process directory */ } finally { unregisterTempDir(owned.root); }
  }
}
