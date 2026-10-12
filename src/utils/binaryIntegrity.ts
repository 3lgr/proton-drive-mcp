// S-01: the server runs a closed binary with the user's authenticated session. Resolve it once to an absolute
// path, optionally pin it by SHA-256 (PROTON_DRIVE_BIN_SHA256), and tell `doctor` when it comes from places other
// people can write to. The hash is checked right before each spawn (re-read when the file's identity changes);
// a swap between the check and exec by someone who can already write the file's directory is the residual risk.
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { dirname } from "node:path";
import { resolveBinary } from "./claudeConfig.js";
import { DriveCliError } from "./errors.js";

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

let verified: { sig: string; ok: boolean } | undefined;
const signature = (path: string): string => {
  const st = statSync(path);
  return `${path}|${st.dev}|${st.ino}|${st.size}|${st.mtimeMs}|${expectedSha256()}`;
};

/** Returns the path to spawn. With a pin set, hashes the file first and throws on any mismatch or read error. */
export async function trustedBinary(): Promise<string> {
  const path = binaryPath();
  const want = expectedSha256();
  if (!want) return path;
  let sig: string;
  try { sig = signature(path); }
  catch { throw new DriveCliError(`${HASH_ENV} is set but the binary cannot be inspected: ${path}`); }
  if (verified?.sig === sig) {
    if (verified.ok) return path;
    throw new DriveCliError(`the proton-drive binary does not match ${HASH_ENV}; refusing to run it`);
  }
  let got: string;
  try { got = await hashFile(path); }
  catch { throw new DriveCliError(`${HASH_ENV} is set but the binary cannot be read: ${path}`); }
  verified = { sig, ok: got === want };
  if (!verified.ok) throw new DriveCliError(`the proton-drive binary at ${path} does not match ${HASH_ENV} (got ${got.slice(0, 12)}…); refusing to run it`);
  return path;
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
