// N-02: drive_read_file refuses known secrets and credential folders. Names are folded before comparing (Unicode
// compatibility form, case, invisible code points, trailing dots and spaces) because the file systems that hold the
// sync folder do the same, and both the lexical spelling and the resolved (symlink-followed) location are judged.
// PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 lifts it. (drive_write_file was removed in 2.0.1: writing into a folder that
// other programs trust cannot be made safe against planted executables and configuration.)
import { basename, relative, sep } from "node:path";
import { isSecretName, isSensitiveLocation, sensitiveRulesEnabled } from "./localguard.js";

const NO_READ_DIRS: readonly (readonly string[])[] = [[".ssh"], [".gnupg"], [".aws"], [".kube"], [".docker"], [".git", "config"]];
// Code points that APFS/HFS+ and most renderers ignore: zero-width, bidi controls, BOM, soft hyphen.
const INVISIBLE = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** One path component as the file system will compare it. */
export function foldName(component: string): string {
  return component.normalize("NFKC").replace(INVISIBLE, "").normalize("NFKC").toLowerCase().replace(/[. \u00a0]+$/, "");
}

function componentsOf(relPath: string): string[] {
  // Split on both separators BEFORE folding: a fullwidth slash is not a separator, a backslash is on Windows.
  return relPath.split(/[\\/]+/).filter((s) => s !== "" && s !== ".").map(foldName);
}

function refusal(why: string): Error {
  return new Error(
    `refusing to read ${why} in the sync folder; known secrets and credential folders are not readable through the model. ` +
      "Set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 only if you accept that the model can read your secrets.",
  );
}

/** Throws when any of `relPaths` names a known secret or a credential folder. */
export function assertSyncReadable(relPaths: readonly string[], fullPaths: readonly string[] = []): void {
  if (!sensitiveRulesEnabled()) return;
  for (const rel of relPaths) {
    const segs = componentsOf(rel);
    const name = segs[segs.length - 1] ?? "";
    if (isSecretName(name)) throw refusal("a file that looks like a credential or secret");
    for (const chain of NO_READ_DIRS) {
      for (let i = 0; i + chain.length <= segs.length; i++) {
        if (chain.every((c, k) => segs[i + k] === c)) throw refusal("a credential or repository-config file");
      }
    }
  }
  for (const full of fullPaths) if (isSensitiveLocation(full, basename(full))) throw refusal("a file in a protected location");
}

/** Relative path of `target` under `root`, with "/" separators ("" when equal). */
export function relUnder(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}
