// Scratch space. There is NO fixed, shared, predictable location: each process makes its own directory with a random
// name (mkdtemp, 0700) under the OS temp dir, checks that it is a real directory of this user with mode 0700, and
// puts every per-operation scratch directory inside it. If the OS temp dir cannot be used, the same is tried inside
// an allowed local root (<root>/.pdmcp-private-<random>); if that fails too the operation fails with a clear message.
// Cleanup is in the `finally` of each operation and at shutdown/exit; nothing sweeps directories left by a killed
// process (an orphan is preferred to deleting something that is not provably ours).
//
// `watchTreeBudget` enforces the per-operation ceiling WHILE the (closed) CLI writes: it counts bytes and entries
// and aborts the operation the moment a limit is crossed, so a lying or runaway transfer cannot fill the disk first.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRoots } from "./localguard.js";
import { registerTempDir, removeAllTempDirsSync } from "./tempDirs.js";

const mine = (st: { uid: number }): boolean => typeof process.getuid !== "function" || st.uid === process.getuid();

export interface OwnedTemp {
  /** The per-operation directory; remove it (removeTreeSafe) in `finally`. */
  readonly root: string;
  /** An empty 0700 subdirectory for code that expects to own its directory. */
  readonly work: string;
}

function verifiedPrivateDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || !mine(st)) return false;
    if ((st.mode & 0o777) !== 0o700) { chmodSync(dir, 0o700); if ((lstatSync(dir).mode & 0o777) !== 0o700) return false; }
    return true;
  } catch { return false; }
}

let processDir: string | undefined;

/** This process's private scratch directory (created on first use, random name, 0700, verified). */
export function processTempDir(): string {
  if (processDir && verifiedPrivateDir(processDir)) return processDir;
  const candidates: Array<() => string> = [() => mkdtempSync(join(tmpdir(), "pdmcp-"))];
  try { for (const r of activeRoots()) candidates.push(() => mkdtempSync(join(r, ".pdmcp-private-"))); } catch { /* no usable root */ }
  for (const make of candidates) {
    try {
      const dir = make();
      if (!verifiedPrivateDir(dir)) continue;
      processDir = dir;
      registerTempDir(dir);
      if (!hooked) { hooked = true; process.once("exit", removeAllTempDirsSync); }
      return dir;
    } catch { /* try the next candidate */ }
  }
  throw new Error("no usable private temporary directory: neither the OS temp dir nor an allowed local folder accepts a new 0700 directory owned by this user. Check permissions and free space, or set TMPDIR.");
}
let hooked = false;

/** A new per-operation scratch directory (random name, 0700) inside this process's directory. */
export function createOwnedTemp(prefix: string): OwnedTemp {
  const root = mkdtempSync(join(processTempDir(), prefix));
  chmodSync(root, 0o700);
  const work = join(root, "w");
  mkdirSync(work, { mode: 0o700 });
  registerTempDir(root);
  return { root, work };
}

export interface TreeBudget { readonly maxBytes: number; readonly maxEntries: number }

function overBudget(dir: string, limits: TreeBudget): "bytes" | "entries" | undefined {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let names: string[];
    try { names = readdirSync(d); } catch { continue; } // being written to; look again on the next tick
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (++entries > limits.maxEntries) return "entries";
      if (st.isDirectory() && !st.isSymbolicLink()) stack.push(p);
      else { bytes += st.size; if (bytes > limits.maxBytes) return "bytes"; }
    }
  }
  return undefined;
}

/**
 * Polls `dir` while an operation writes into it and calls `onExceed` once when the tree crosses a limit (the caller
 * aborts the operation). Returns `stop`, to be called in `finally`.
 */
export function watchTreeBudget(dir: string, limits: TreeBudget, onExceed: (what: "bytes" | "entries") => void, everyMs = 50): () => void {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const over = overBudget(dir, limits);
    if (over) { fired = true; onExceed(over); }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
