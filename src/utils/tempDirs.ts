import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";

/** Directories frozen read-only (upload snapshots) must be made writable before they can be removed. */
function thaw(path: string): void {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (!st.isDirectory()) return;
  try { chmodSync(path, 0o700); } catch { /* removal reports it */ }
  let names: string[] = [];
  try { names = readdirSync(path); } catch { /* unreadable */ }
  for (const n of names) thaw(`${path}/${n}`);
}

const live = new Set<string>();

/** Tracks a temp dir that must not outlive the process (shutdown() skips the callers' `finally` blocks). */
export const registerTempDir = (dir: string): void => { live.add(dir); };
export const unregisterTempDir = (dir: string): void => { live.delete(dir); };

/** Synchronous so it can run right before process.exit. */
export function removeAllTempDirsSync(): void {
  for (const dir of live) {
    thaw(dir);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  live.clear();
}
