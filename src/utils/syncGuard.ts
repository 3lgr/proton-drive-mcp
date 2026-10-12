// N-02: the sync folder is a place whose files get executed or interpreted by other programs (git hooks, shell
// rc files, editor tasks, CI workflows, agent settings) and a place secrets live. drive_write_file and
// drive_read_file apply the same secret-name rule as the local-path tools, plus a list of locations that are never
// written by default. Both a new file and an overwrite are refused. PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 lifts it.
import { basename, relative, sep } from "node:path";
import { isSecretName, isSensitiveLocation, sensitiveRulesEnabled } from "./localguard.js";

// Directory chains (consecutive segments, anywhere in the path, case-insensitive).
const NO_WRITE_DIRS: readonly (readonly string[])[] = [
  [".git"], [".ssh"], [".gnupg"], [".aws"], [".kube"], [".docker"], [".vscode"], [".idea"], [".husky"], [".devcontainer"],
  [".circleci"], [".github", "workflows"], [".github", "actions"], [".claude"], [".cursor"], [".config", "fish"],
  ["library", "launchagents"], ["library", "launchdaemons"],
];
const NO_WRITE_NAMES: ReadonlySet<string> = new Set([
  ".envrc", ".gitconfig", ".gitmodules", ".gitlab-ci.yml", ".pre-commit-config.yaml", "lefthook.yml", ".mcp.json",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
  ".profile", ".login", ".cshrc", ".tcshrc", ".kshrc", ".yarnrc", ".yarnrc.yml", "authorized_keys",
]);
// Directories whose files are read only by their owner tool: never useful as model context, often secret.
const NO_READ_DIRS: readonly (readonly string[])[] = [[".ssh"], [".gnupg"], [".aws"], [".kube"], [".docker"], [".git", "config"]];

function hasChain(segments: readonly string[], chain: readonly string[]): boolean {
  for (let i = 0; i + chain.length <= segments.length; i++) {
    if (chain.every((c, k) => segments[i + k] === c)) return true;
  }
  return false;
}

function segmentsOf(relPath: string): string[] {
  return relPath.split(/[\\/]+/).filter((s) => s !== "" && s !== ".").map((s) => s.normalize("NFC").toLowerCase());
}

function refusal(action: "write" | "read", why: string): Error {
  return new Error(
    `refusing to ${action} ${why} in the sync folder. ` +
      `Set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 only if you accept that the model can ${action === "write" ? "plant files that other programs execute or trust" : "read your secrets"}.`,
  );
}

/** Throws when `relPath` (relative to the sync root, lexical or resolved) may not be written. */
export function assertSyncWritable(relPaths: readonly string[], fullPaths: readonly string[] = []): void {
  if (!sensitiveRulesEnabled()) return;
  for (const rel of relPaths) {
    const segs = segmentsOf(rel);
    const name = segs[segs.length - 1] ?? "";
    if (isSecretName(name)) throw refusal("write", "a file that looks like a credential or secret");
    if (NO_WRITE_NAMES.has(name)) throw refusal("write", "a file that configures or runs other programs");
    if (NO_WRITE_DIRS.some((c) => hasChain(segs.slice(0, -1), c))) throw refusal("write", "into a folder that configures or runs other programs");
  }
  for (const full of fullPaths) if (isSensitiveLocation(full, basename(full))) throw refusal("write", "into a protected location");
}

/** Throws when `relPath` names a known secret or a credential folder. */
export function assertSyncReadable(relPaths: readonly string[], fullPaths: readonly string[] = []): void {
  if (!sensitiveRulesEnabled()) return;
  for (const rel of relPaths) {
    const segs = segmentsOf(rel);
    const name = segs[segs.length - 1] ?? "";
    if (isSecretName(name)) throw refusal("read", "a file that looks like a credential or secret");
    if (NO_READ_DIRS.some((c) => hasChain(segs, c))) throw refusal("read", "a credential or repository-config file");
  }
  for (const full of fullPaths) if (isSensitiveLocation(full, basename(full))) throw refusal("read", "a file in a protected location");
}

/** Relative path of `target` under `root`, with "/" separators ("" when equal). */
export function relUnder(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

