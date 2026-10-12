// Startup sweep of scratch directories left by a killed process (SIGKILL mid-download). It looks ONLY at the two
// fixed private bases the server creates itself (see privateTemp.ts), and deletes only marked, old, orphaned
// directories. pdmcp-bin-* (the verified CLI copy a sibling instance runs) is not scratch and is never touched.
import { activeRoots } from "./localguard.js";
import { ROOT_PRIVATE_NAME, serverTempBase, sweepOwned } from "./privateTemp.js";
import { join } from "node:path";

/** Sweeps one private base (default: the server's temp base). Best-effort, never throws. */
export async function sweepStaleTempDirs(base: string = serverTempBase(), maxAgeMs = 3600_000): Promise<void> {
  sweepOwned(base, maxAgeMs);
}

/** Sweeps `<allowed root>/.pdmcp-private` for every active root. Never throws. */
export async function sweepStagingDirs(maxAgeMs = 3600_000): Promise<void> {
  let roots: string[];
  try { roots = activeRoots(); } catch { return; }
  for (const root of roots) sweepOwned(join(root, ROOT_PRIVATE_NAME), maxAgeMs);
}
