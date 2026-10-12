// S-01: the server runs a closed binary with the user's authenticated session.
// Without a pin it runs the binary by resolved absolute path. With PROTON_DRIVE_BIN_SHA256 set, the verified bytes
// themselves are what runs: the binary is copied into a private 0700 directory (created O_EXCL), the hash is taken
// of THE COPY, the copy is made read-only (0500) and only the copy is ever executed. There is no window between
// "checked" and "executed" on a path someone else can write, and no verification cache keyed on file attributes.
// If the copy cannot be made or does not match, nothing runs (fail closed).
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBinary } from "./claudeConfig.js";
import { DriveCliError } from "./errors.js";
import { registerTempDir, unregisterTempDir } from "./tempDirs.js";

export const BIN_ENV = "PROTON_DRIVE_BIN";
export const HASH_ENV = "PROTON_DRIVE_BIN_SHA256";

/** The configured name or path, as the user wrote it (empty counts as unset). */
export const configuredBinary = (): string => process.env[BIN_ENV] || "proton-drive";

/** Absolute path when the binary can be located; otherwise the configured name (spawn reports ENOENT). */
export function binaryPath(): string {
  return resolveBinary(configuredBinary()) ?? configuredBinary();
}

/** Lower-case 64-hex pin, undefined when unset; throws on a malformed value (fail closed, never ignored). */
export function expectedSha256(): string | undefined {
  const raw = process.env[HASH_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(v)) throw new DriveCliError(`${HASH_ENV} must be 64 hexadecimal characters (sha256 of the proton-drive binary)`);
  return v;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

interface PrivateCopy { readonly dir: string; readonly path: string; readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number }
let copying: Promise<PrivateCopy> | undefined;
let hooked = false;

function cleanupCopy(): void {
  // sync on purpose: runs from process 'exit'
  if (!copying) return;
  copying.then((c) => rmSync(c.dir, { recursive: true, force: true }), () => undefined);
}

async function makeVerifiedCopy(source: string, want: string): Promise<PrivateCopy> {
  const dir = mkdtempSync(join(tmpdir(), "pdmcp-bin-")); // mode 0700
  registerTempDir(dir);
  const fail = (msg: string): never => { rmSync(dir, { recursive: true, force: true }); unregisterTempDir(dir); throw new DriveCliError(msg); };
  const dest = join(dir, "proton-drive");
  try {
    await pipeline(createReadStream(source), createWriteStream(dest, { flags: "wx", mode: 0o700 }));
  } catch {
    return fail(`${HASH_ENV} is set but the binary at ${source} could not be copied for verification; refusing to run it`);
  }
  let got: string;
  try { got = await hashFile(dest); } catch { return fail("the verified copy of the proton-drive binary could not be read; refusing to run it"); }
  if (got !== want) return fail(`the proton-drive binary at ${source} does not match ${HASH_ENV} (got ${got.slice(0, 12)}…); refusing to run it`);
  chmodSync(dest, 0o500);
  const st = lstatSync(dest);
  if (!st.isFile() || (st.mode & 0o777) !== 0o500) return fail("the verified copy of the proton-drive binary has unexpected attributes; refusing to run it");
  return { dir, path: dest, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}

/** Path to execute. With a pin: the private verified copy (created on first use). Never the original afterwards. */
export async function trustedBinary(): Promise<string> {
  const want = expectedSha256();
  if (!want) return binaryPath();
  if (!hooked) { hooked = true; process.once("exit", cleanupCopy); }
  const source = binaryPath();
  if (!copying) {
    copying = makeVerifiedCopy(source, want);
    copying.catch(() => { copying = undefined; }); // a failure is never remembered as "verified"; the next call tries again
  }
  const c = await copying;
  // Tripwire on OUR copy (not a cache of the original): same inode, size, mtime and still 0500.
  let st;
  try { st = lstatSync(c.path); } catch { copying = undefined; throw new DriveCliError("the verified copy of the proton-drive binary disappeared; refusing to run"); }
  if (!st.isFile() || st.dev !== c.dev || st.ino !== c.ino || st.size !== c.size || st.mtimeMs !== c.mtimeMs || (st.mode & 0o777) !== 0o500) {
    copying = undefined;
    throw new DriveCliError("the verified copy of the proton-drive binary was modified; refusing to run it");
  }
  if (await hashFile(c.path) !== want) { copying = undefined; throw new DriveCliError("the verified copy of the proton-drive binary no longer matches the pin; refusing to run it"); }
  return c.path;
}

/** Test seam: forget the private copy (and remove it). */
export function resetBinaryStateForTests(): void {
  cleanupCopy();
  copying = undefined;
}

export interface BinaryRisk { id: string; message: string }

/** Facts `doctor` reports: where the binary comes from, and who else could replace it. */
export function binaryRisks(path: string): BinaryRisk[] {
  const risks: BinaryRisk[] = [];
  const cfg = configuredBinary();
  if (!cfg.includes("/") && !cfg.includes("\\")) {
    risks.push({ id: "from-path", message: `the binary was found by searching PATH (${path}); set ${BIN_ENV} to its absolute path so a PATH change cannot swap it` });
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const check = (target: string, label: string): void => {
    try {
      const st = statSync(target);
      if ((st.mode & 0o022) !== 0) risks.push({ id: "writable", message: `${label} ${target} is writable by group or others` });
      if (uid !== undefined && st.uid !== uid && st.uid !== 0) risks.push({ id: "owner", message: `${label} ${target} is owned by uid ${st.uid}, not you or root` });
    } catch { /* reported elsewhere as not executable */ }
  };
  check(path, "the binary");
  check(dirname(path), "its directory");
  return risks;
}
