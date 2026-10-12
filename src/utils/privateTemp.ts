// The only place the server creates, recognises and removes its own scratch directories.
//
//   - Every scratch dir lives under ONE fixed, private base created by the server (0700, ours): either
//     <os tmpdir>/pdmcp-private-<uid> or <allowed local root>/.pdmcp-private. Nothing is ever created next to a
//     user-chosen destination, and no sweep ever looks outside those two bases.
//   - Every scratch dir carries a marker file (.pdmcp-owner: random token, creator pid, creation time) written at
//     creation. The sweeper deletes a directory only if ALL of these hold: it is a real directory (lstat, not a
//     symlink), owned by this uid, mode 0700, on the same device as the base, holds a well-formed marker that is a
//     regular file of this uid, is older than the age limit, and its creator pid is gone. Anything else is skipped.
//   - Removal never builds a path from a name and hands it to a recursive delete: each directory is opened without
//     following symlinks, every entry is lstat'ed, files and links are unlinked (never followed), directories are
//     emptied and rmdir'ed, with depth and entry limits. Any surprise aborts that directory (fail closed).
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync,
  rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MARKER_NAME = ".pdmcp-owner";
export const ROOT_PRIVATE_NAME = ".pdmcp-private";
const MAX_DEPTH = 64;
const MAX_ENTRIES = 200_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const uid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);
const mine = (st: { uid: number }): boolean => uid() === undefined || st.uid === uid();

export interface OwnedTemp {
  /** The directory carrying the marker; remove this one. */
  readonly root: string;
  /** An empty 0700 subdirectory to hand to code that expects to own its directory. */
  readonly work: string;
}

/** <os tmpdir>/pdmcp-private-<uid> */
export function serverTempBase(): string {
  return join(tmpdir(), `pdmcp-private-${uid() ?? "x"}`);
}

/** Creates (0700) or verifies a base directory. Returns false when it is not a private, real directory of ours. */
export function ensurePrivateBase(dir: string): boolean {
  try {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false; }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || !mine(st)) return false;
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    return true;
  } catch { return false; }
}

/** A new marked scratch directory under `base` (which must be a private base). Throws when it cannot be made safely. */
export function createOwnedTemp(base: string, prefix: string): OwnedTemp {
  if (!ensurePrivateBase(base)) throw new Error("cannot create a private temporary directory: its base is not a private directory of this user");
  const root = mkdtempSync(join(base, prefix));
  chmodSync(root, 0o700);
  const marker = JSON.stringify({ v: 1, token: randomBytes(16).toString("hex"), pid: process.pid, createdAt: Date.now() });
  writeFileSync(join(root, MARKER_NAME), marker, { mode: 0o600, flag: "wx" });
  const work = join(root, "w");
  mkdirSync(work, { mode: 0o700 });
  return { root, work };
}

/** Removes a directory tree without following links; frozen (read-only) directories are made writable first. */
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

interface Marker { token: string; pid: number; createdAt: number }

function readMarker(dir: string): Marker | undefined {
  const file = join(dir, MARKER_NAME);
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || !mine(st) || st.nlink !== 1 || st.size > 512) return undefined;
  const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const buf = Buffer.alloc(513);
    const n = readSync(fd, buf, 0, 513, 0);
    if (n > 512) return undefined;
    const m = JSON.parse(buf.subarray(0, n).toString("utf8")) as Partial<Marker> & { v?: unknown };
    if (m.v !== 1 || typeof m.token !== "string" || !/^[0-9a-f]{32}$/.test(m.token)) return undefined;
    if (!Number.isInteger(m.pid) || (m.pid as number) <= 0 || typeof m.createdAt !== "number" || !Number.isFinite(m.createdAt)) return undefined;
    return { token: m.token, pid: m.pid as number, createdAt: m.createdAt };
  } finally { closeSync(fd); }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } // EPERM: it exists
}

/** Removes abandoned scratch dirs directly under `base` (see the header for the rules). Never throws. */
export function sweepOwned(base: string, maxAgeMs = 3600_000, isAlive: (pid: number) => boolean = pidAlive): void {
  let names: string[];
  let baseStat;
  try {
    baseStat = lstatSync(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || !mine(baseStat) || (baseStat.mode & 0o077) !== 0) return;
    names = readdirSync(base);
  } catch { return; }
  for (const name of names) {
    try {
      if (!/^pdmcp-(?:read|dup|upload|stage)-[A-Za-z0-9]{6}$/.test(name)) continue;
      const dir = join(base, name);
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || !mine(st) || (st.mode & 0o777) !== 0o700 || st.dev !== baseStat.dev) continue;
      const marker = readMarker(dir);
      if (!marker) continue;
      if (Date.now() - marker.createdAt < maxAgeMs) continue;
      if (marker.pid === process.pid || isAlive(marker.pid)) continue;
      removeTreeSafe(dir);
    } catch { /* skip: anything unexpected means "not ours to delete" */ }
  }
}
