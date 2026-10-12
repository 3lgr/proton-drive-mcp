import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const MAX_DEPTH = 64;
const MAX_ENTRIES = 200_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const mine = (st: { uid: number }): boolean => typeof process.getuid !== "function" || st.uid === process.getuid();

/**
 * Removes a directory tree this process created, without following links: each directory is opened with
 * O_NOFOLLOW|O_DIRECTORY (and made writable if it was frozen read-only), every entry is lstat'ed, files and links are
 * unlinked, directories are emptied and rmdir'ed. Depth and entry counts are bounded; any surprise throws.
 */
export function removeTreeSafe(path: string): void {
  const budget = { entries: MAX_ENTRIES };
  const removeDir = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error("tree too deep");
    const fd = openSync(dir, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isDirectory() || !mine(st)) throw new Error("not a directory of ours");
      fchmodSync(fd, 0o700);
      const again = lstatSync(dir); // the name must still be the directory we opened
      if (again.ino !== st.ino || again.dev !== st.dev) throw new Error("directory changed while it was being removed");
    } finally { closeSync(fd); }
    for (const name of readdirSync(dir)) {
      if (--budget.entries < 0) throw new Error("too many entries");
      const child = join(dir, name);
      const cst = lstatSync(child);
      if (cst.isDirectory() && !cst.isSymbolicLink()) removeDir(child, depth + 1);
      else unlinkSync(child);
    }
    rmdirSync(dir);
  };
  removeDir(path, 0);
}

const live = new Set<string>();

/** Tracks a temp dir that must not outlive the process (shutdown() skips the callers' `finally` blocks). */
export const registerTempDir = (dir: string): void => { live.add(dir); };
export const unregisterTempDir = (dir: string): void => { live.delete(dir); };

/** Synchronous so it can run right before process.exit. */
export function removeAllTempDirsSync(): void {
  for (const dir of live) {
    try { removeTreeSafe(dir); } catch { /* best effort: only ever a directory this process created */ }
  }
  live.clear();
}
