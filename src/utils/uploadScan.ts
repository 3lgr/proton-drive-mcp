// F-04: validateLocalPath checks the path the model named; an uploaded FOLDER brings everything below it.
// Before the CLI reads a directory tree, walk it with the existing bounded scanner and refuse the whole call if it
// holds a secret-looking file, a protected location, or any symlink (the closed CLI may follow links).
import { lstatSync } from "node:fs";
import { scanLocal, MAX_LOCAL_ENTRIES } from "../services/plan.js";
import { showValue } from "./text.js";

export interface UploadScanOptions { maxEntries?: number }

export function assertUploadTreeClean(path: string, opts: UploadScanOptions = {}): void {
  let isDir: boolean;
  try { isDir = lstatSync(path).isDirectory(); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // nothing there to leak; the CLI reports the missing path
    throw e;
  }
  if (!isDir) return; // a single file was already checked by validateLocalPath (symlink resolved)
  const scan = scanLocal(path, () => false, opts.maxEntries ?? MAX_LOCAL_ENTRIES);
  if (scan.truncated) {
    throw new Error(`refusing to upload ${showValue(path)}: the folder is too large to scan completely before upload. Upload subfolders separately.`);
  }
  if (scan.findings.length === 0) return;
  const list = scan.findings.map((f) => `${showValue(f.path, 80, 30)} (${f.reason === "symlink" ? "symlink" : "secret or protected file"})`).join(", ");
  const more = scan.symlinksSkipped + scan.protectedSkipped > scan.findings.length ? ` and ${scan.symlinksSkipped + scan.protectedSkipped - scan.findings.length} more` : "";
  throw new Error(
    `refusing to upload ${showValue(path)}: it contains entries that must not leave this machine: ${list}${more}. ` +
    "Remove or move them, or upload specific files instead (PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 lifts the secret-name rule, never the symlink rule).",
  );
}
