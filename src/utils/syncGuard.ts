// N-02: the sync folder is where files get executed or interpreted by other programs (git hooks, shell rc files,
// editor tasks, CI workflows, build scripts, agent settings) and where secrets live. A denylist of such names can
// never be complete, so WRITING is an allowlist: only inert data extensions, in paths with no dot-prefixed
// component, never a name that looks like a secret. Everything else is refused, for a new file and for an
// overwrite alike. READING refuses known secrets and credential folders. Names are folded before comparing
// (Unicode compatibility form, case, invisible code points, trailing dots and spaces) because the file systems
// that hold the sync folder do the same. PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 lifts both rules.
import { basename, relative, sep } from "node:path";
import { isSecretName, isSensitiveLocation, sensitiveRulesEnabled } from "./localguard.js";

/** Extensions of files that no common tool executes or loads as configuration by itself. */
export const WRITABLE_EXTENSIONS: ReadonlySet<string> = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".yaml", ".yml", ".log", ".xml", ".html"]);
// Inert extension, but a tool runs them (npm scripts, composer scripts, deno tasks).
const EXECUTED_NAMES: ReadonlySet<string> = new Set(["package.json", "composer.json", "deno.json", "deno.jsonc"]);
// macOS bundles / launchers: a folder with one of these extensions is executable content.
const BUNDLE_EXTENSIONS: ReadonlySet<string> = new Set([".app", ".workflow", ".action", ".command", ".bundle", ".plugin", ".kext", ".pkg", ".framework"]);
const NO_READ_DIRS: readonly (readonly string[])[] = [[".ssh"], [".gnupg"], [".aws"], [".kube"], [".docker"], [".git", "config"]];
// Code points that APFS/HFS+ and most renderers ignore: zero-width, bidi controls, BOM, soft hyphen.
const INVISIBLE = /[­؜​-‏‪-‮⁠-⁩﻿]/g;

/** One path component as the file system will compare it. */
export function foldName(component: string): string {
  return component.normalize("NFKC").replace(INVISIBLE, "").normalize("NFKC").toLowerCase().replace(/[.  ]+$/, "");
}

function componentsOf(relPath: string): string[] {
  // Split on both separators BEFORE folding: a fullwidth slash is not a separator, a backslash is on Windows.
  return relPath.split(/[\\/]+/).filter((s) => s !== "" && s !== ".").map(foldName);
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
};

function refusal(action: "write" | "read", why: string): Error {
  const hint = action === "write"
    ? `drive_write_file only writes plain data files (${[...WRITABLE_EXTENSIONS].join(" ")}) in non-hidden folders`
    : "known secrets and credential folders are not readable through the model";
  return new Error(
    `refusing to ${action} ${why} in the sync folder; ${hint}. ` +
      `Set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 only if you accept that the model can ${action === "write" ? "plant files that other programs execute or trust" : "read your secrets"}.`,
  );
}

function assertWritableRel(rel: string): void {
  const segs = componentsOf(rel);
  const name = segs[segs.length - 1];
  if (name === undefined) throw refusal("write", "an empty path");
  if (segs.some((s) => s.startsWith("."))) throw refusal("write", "a hidden file or folder (a name starting with '.')");
  if (segs.some((s) => s.includes(":"))) throw refusal("write", "a name containing ':'");
  if (segs.slice(0, -1).some((s) => BUNDLE_EXTENSIONS.has(extensionOf(s)))) throw refusal("write", "inside an application bundle or launcher folder");
  if (isSecretName(name)) throw refusal("write", "a file that looks like a credential or secret");
  if (EXECUTED_NAMES.has(name)) throw refusal("write", "a file that tools execute (package scripts)");
  if (!WRITABLE_EXTENSIONS.has(extensionOf(name))) throw refusal("write", "a file with an extension that is not a plain data format");
}

/** Throws when any of `relPaths` (relative to the sync root: the lexical spelling and the resolved one) may not be written. */
export function assertSyncWritable(relPaths: readonly string[], fullPaths: readonly string[] = []): void {
  if (!sensitiveRulesEnabled()) return;
  for (const rel of relPaths) assertWritableRel(rel);
  for (const full of fullPaths) if (isSensitiveLocation(full, basename(full))) throw refusal("write", "into a protected location");
}

/** Throws when any of `relPaths` names a known secret or a credential folder. */
export function assertSyncReadable(relPaths: readonly string[], fullPaths: readonly string[] = []): void {
  if (!sensitiveRulesEnabled()) return;
  for (const rel of relPaths) {
    const segs = componentsOf(rel);
    const name = segs[segs.length - 1] ?? "";
    if (isSecretName(name)) throw refusal("read", "a file that looks like a credential or secret");
    for (const chain of NO_READ_DIRS) {
      for (let i = 0; i + chain.length <= segs.length; i++) {
        if (chain.every((c, k) => segs[i + k] === c)) throw refusal("read", "a credential or repository-config file");
      }
    }
  }
  for (const full of fullPaths) if (isSensitiveLocation(full, basename(full))) throw refusal("read", "a file in a protected location");
}

/** Relative path of `target` under `root`, with "/" separators ("" when equal). */
export function relUnder(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}
