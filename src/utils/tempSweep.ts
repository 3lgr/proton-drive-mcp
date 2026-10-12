import { readdir, lstat, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRoots } from "./localguard.js";

const STAGING_DIR_NAME = ".pdmcp-staging"; // same name as services/downloadGuard.ts (kept literal to avoid an import cycle)

// N-07: pdmcp-bin-* is NOT here. It is the verified copy of the CLI that a running sibling instance executes;
// age does not mean abandoned, so it is never swept (binaryIntegrity owns its lifetime).
// The optional leading dot covers staging dirs that older versions created beside a destination.
const PREFIX = /^\.?pdmcp-(?:read|dup|upload|stage)-/;

async function thawAndRemove(p: string): Promise<void> {
  const walk = async (d: string): Promise<void> => {
    try {
      const st = await lstat(d);
      if (!st.isDirectory()) return;
      await chmod(d, 0o700);
      for (const n of await readdir(d)) await walk(join(d, n));
    } catch { /* best effort */ }
  };
  await walk(p);
  await rm(p, { recursive: true, force: true });
}

/**
 * Best-effort: removes pdmcp-read-*, pdmcp-dup-*, pdmcp-upload-* and pdmcp-stage-* temp dirs left by a killed process (SIGTERM mid-download).
 * Only real directories (lstat, never followed) owned by this uid and older than maxAgeMs are touched.
 */
export async function sweepStaleTempDirs(dir = tmpdir(), maxAgeMs = 3600_000): Promise<void> {
  const uid = process.getuid?.();
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => PREFIX.test(n)); } catch { return; }
  for (const n of names) {
    try {
      const p = join(dir, n);
      const st = await lstat(p);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || Date.now() - st.mtimeMs < maxAgeMs) continue;
      await thawAndRemove(p);
    } catch { /* gone, busy or not ours: skip */ }
  }
}

/**
 * N-05: stage dirs live in <allowed root>/.pdmcp-staging (and, from older versions, directly in the root). Same age and
 * ownership rules as the temp sweep. Never throws.
 */
export async function sweepStagingDirs(maxAgeMs = 3600_000): Promise<void> {
  let roots: string[];
  try { roots = activeRoots(); } catch { return; }
  for (const root of roots) {
    await sweepStaleTempDirs(join(root, STAGING_DIR_NAME), maxAgeMs);
    await sweepStaleTempDirs(root, maxAgeMs);
  }
}
