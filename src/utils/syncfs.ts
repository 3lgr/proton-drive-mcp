// fs/promises.realpath has the semantics of fs.realpath.native (the OS canonicalises case and symlinks).
import { open, realpath, lstat } from "node:fs/promises";
import { constants as fsc } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { assertSyncReadable, relUnder } from "./syncGuard.js";

const READ_LIMIT = 1 * 1024 * 1024; // 1 MB — prevent context overflow
const NOFOLLOW = fsc.O_NOFOLLOW ?? 0; // 0 on platforms without it (Windows)

export function getSyncRoot(): string | null {
  return process.env["PROTON_DRIVE_SYNC_PATH"] ?? null;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

// Drive roots other than /my-files are not part of the desktop sync folder.
const UNSYNCED_ROOTS = ["photos", "albums", "trash", "photos-trash", "shared-with-me", "shared-by-me", "devices"];

/**
 * Map a remote Drive path to an absolute local path inside syncRoot. Lexical only; rejects traversal.
 * The sync folder's top level is Drive's /my-files, so `/my-files/<rest>` maps to `<syncRoot>/<rest>`.
 * Paths not under a known Drive root are (legacy) relative to the sync root.
 */
export function resolveSyncPath(syncRoot: string, remotePath: string): string {
  const trimmed = remotePath.replace(/^\//, "");
  const first = trimmed.split("/", 1)[0];
  if (UNSYNCED_ROOTS.includes(first)) {
    throw new Error(`only /my-files is synced to the local folder; /${first} is not: ${remotePath}`);
  }
  const rel = first === "my-files" ? trimmed.slice("my-files".length).replace(/^\//, "") : trimmed;
  const resolved = resolve(join(syncRoot, rel));
  const root = resolve(syncRoot);
  if (!isInside(root, resolved)) {
    throw new Error(`path resolves outside sync root: ${remotePath}`);
  }
  return resolved;
}

/**
 * realpath of the deepest existing ancestor of p, with the not-yet-existing
 * remainder appended. A dangling symlink is refused (its target is unknowable).
 */
async function realResolve(p: string, remotePath: string): Promise<string> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await realpath(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      let isLink = false;
      try {
        isLink = (await lstat(cur)).isSymbolicLink();
      } catch {
        /* does not exist at all */
      }
      if (isLink) throw new Error(`path resolves outside sync root: ${remotePath}`);
      const parent = dirname(cur);
      if (parent === cur) throw e;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

async function realRootOf(syncRoot: string, remotePath: string): Promise<string> {
  return realResolve(resolve(syncRoot), remotePath);
}

function assertInside(realRoot: string, real: string, remotePath: string): void {
  if (!isInside(realRoot, real)) {
    throw new Error(`path resolves outside sync root: ${remotePath}`);
  }
}

/** Lexical + realpath containment. Returns { realRoot, real } for the target. */
async function containedReal(
  syncRoot: string,
  remotePath: string
): Promise<{ realRoot: string; real: string }> {
  const full = resolveSyncPath(syncRoot, remotePath);
  const realRoot = await realRootOf(syncRoot, remotePath);
  const real = await realResolve(full, remotePath);
  assertInside(realRoot, real, remotePath);
  return { realRoot, real };
}

export async function readSyncFile(syncRoot: string, remotePath: string): Promise<string> {
  const { realRoot, real } = await containedReal(syncRoot, remotePath);
  // N-02: judged by the lexical spelling AND by where it really points (an in-root symlink must not hide a secret)
  assertSyncReadable([relUnder(resolve(syncRoot), resolveSyncPath(syncRoot, remotePath)), relUnder(realRoot, real)], [real]);
  // `real` has no symlinks; O_NOFOLLOW closes the swap-after-check window on the last component.
  const fh = await open(real, fsc.O_RDONLY | NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(`${remotePath} is not a regular file.`);
    }
    if (st.size > READ_LIMIT) {
      throw new Error(
        `file is ${st.size} bytes — too large to read into context (limit 1 MB). Use drive_download instead.`
      );
    }
    // Bounded read: never load more than limit+1 even if the file grows after fstat.
    const buf = Buffer.alloc(READ_LIMIT + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > READ_LIMIT) {
      throw new Error(
        `file is over ${READ_LIMIT} bytes — too large to read into context (limit 1 MB). Use drive_download instead.`
      );
    }
    const data = buf.subarray(0, total);
    // Reject binary files (contain null bytes)
    if (data.includes(0)) {
      throw new Error(`${remotePath} appears to be a binary file. Use drive_download instead.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new Error(`${remotePath} is not valid UTF-8 text. Use drive_download instead.`);
    }
  } finally {
    await fh.close();
  }
}
