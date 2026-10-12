import { randomBytes } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_KEY = "proton-drive-mcp";

export interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Default Claude Desktop config location; CLAUDE_DESKTOP_CONFIG overrides it. */
export function defaultConfigPath(): string {
  const override = process.env["CLAUDE_DESKTOP_CONFIG"];
  if (override) return resolve(override);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a command name or path to an absolute executable path, or undefined. */
export function resolveBinary(cmd: string): string | undefined {
  if (!cmd) return undefined;
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) {
    const abs = resolve(cmd);
    return isExecutableFile(abs) ? abs : undefined;
  }
  const exts = process.platform === "win32" ? ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (isExecutableFile(candidate)) return resolve(candidate);
    }
  }
  return undefined;
}

/** The proton-drive CLI the server would use: PROTON_DRIVE_BIN, else PATH lookup. */
export function resolveDriveCli(): string | undefined {
  return resolveBinary(process.env["PROTON_DRIVE_BIN"] || "proton-drive");
}

/** dist/index.js of this package, located relative to this module (not the cwd). */
export function serverEntryPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

/** npx runs packages from a cache that gets pruned; a config pointing there breaks later. */
export function isEphemeralInstall(p: string): boolean {
  return /[\\/]_npx[\\/]/.test(p);
}

/** Group id of macOS `admin`: its members can already act as root, so they are not an extra principal. */
const MACOS_ADMIN_GID = 80;

/**
 * Pure: is a directory with this stat open enough for another principal to swap a link inside it? World-writable
 * always is. Group-writable is accepted only in the standard Homebrew layout (macOS, owned by the current user,
 * group `admin`: /opt/homebrew/bin is drwxrwxr-x user:admin). Windows modes mean nothing, so never "open" there.
 */
export function dirTooOpen(
  st: { mode: number; uid: number; gid: number },
  uid: number | undefined = process.getuid?.(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  if ((st.mode & 0o002) !== 0) return true;
  if ((st.mode & 0o020) === 0) return false;
  return !(platform === "darwin" && uid !== undefined && st.uid === uid && st.gid === MACOS_ADMIN_GID);
}

/**
 * A `node` on PATH that is the same file as the running one, as an absolute path that survives upgrades
 * (/opt/homebrew/bin/node rather than /opt/homebrew/Cellar/node/<version>/bin/node). Same file means equal
 * realpath, so this never selects a different install. Relative and empty PATH entries are skipped (they depend on
 * the cwd), as is a PATH directory that group/others can write to (that directory is the new trust surface: anyone
 * who can write there could swap the link). The real binary's own permissions are not judged: the fallback,
 * process.execPath, is exactly as exposed, and CI tool caches (e.g. /opt/hostedtoolcache) are group-writable.
 * No variable other than PATH is consulted. Any doubt falls back to process.execPath.
 */
export function stableNodePath(execPath: string = process.execPath, pathVar: string = process.env["PATH"] ?? ""): string {
  let real: string;
  try { real = realpathSync(execPath); } catch { return execPath; }
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try { if (isExecutableFile(candidate) && realpathSync(candidate) === real && !dirTooOpen(statSync(dir))) return candidate; } catch { /* dangling link: next */ }
  }
  return execPath;
}

/** The env of our existing entry (string values only), or undefined when the file or entry is missing or unreadable. */
export function readEntryEnv(file: string): Record<string, string> | undefined {
  try {
    const servers = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, { env?: Record<string, unknown> }> }).mcpServers;
    const env = servers?.[SERVER_KEY]?.env;
    if (!env || typeof env !== "object") return undefined;
    return Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => typeof kv[1] === "string"));
  } catch { return undefined; }
}

export function buildEntry(cliPath: string, syncPath?: string, binSha256?: string, preservedEnv: Readonly<Record<string, string>> = {}): McpEntry {
  const entryPath = serverEntryPath();
  if (isEphemeralInstall(entryPath)) {
    throw new Error(`${entryPath} is in a temporary npx cache and would stop working once the cache is pruned. Install it first (see "Install" in the README: npm install -g github:3lgr/proton-drive-mcp#<tag>) and run proton-drive-cli from there.`);
  }
  // Re-running setup never drops what the user configured: existing variables (pin, policy, local root...) are kept.
  // Only the values this run is asked to set replace theirs.
  const env: Record<string, string> = { PROTON_DRIVE_BIN: cliPath };
  const sha = binSha256 ?? preservedEnv["PROTON_DRIVE_BIN_SHA256"];
  if (sha !== undefined) env["PROTON_DRIVE_BIN_SHA256"] = sha;
  const sync = syncPath ?? preservedEnv["PROTON_DRIVE_SYNC_PATH"];
  if (sync !== undefined) env["PROTON_DRIVE_SYNC_PATH"] = sync;
  for (const [k, v] of Object.entries(preservedEnv)) if (!(k in env)) env[k] = v;
  return { command: stableNodePath(), args: [entryPath], env };
}

export function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function parseConfig(file: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`${file} is not valid JSON; refusing to modify it. Fix or move it, then re-run.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object; refusing to modify it.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Adds/replaces only mcpServers["proton-drive-mcp"], keeping everything else.
 * Returns the backup path (undefined when the file did not exist yet).
 */
export function writeEntry(file: string, entry: McpEntry): string | undefined {
  const exists = existsSync(file);
  const config = exists ? parseConfig(file) : {};
  const servers = config["mcpServers"];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`"mcpServers" in ${file} is not an object; refusing to modify it.`);
  }
  const target = exists ? realpathSync(file) : file;
  if (exists && JSON.stringify((servers as Record<string, unknown> | undefined)?.[SERVER_KEY]) === JSON.stringify(entry)) return undefined;
  let backup: string | undefined;
  if (exists) {
    backup = `${target}.bak-${timestamp()}`;
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  config["mcpServers"] = { ...(servers as Record<string, unknown> | undefined), [SERVER_KEY]: entry };
  // Write beside the target and rename, so a crash or a concurrent reader never sees a truncated config.
  // Unpredictable name + O_EXCL: a pre-planted file or symlink at a guessable path can not be written through.
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: exists ? statSync(target).mode & 0o777 : 0o600, flag: "wx" });
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* not created */ }
    throw e;
  }

  const written = (parseConfig(file)["mcpServers"] as Record<string, unknown>)[SERVER_KEY];
  if (JSON.stringify(written) !== JSON.stringify(entry)) throw new Error(`Verification failed: ${file} does not contain the expected entry.`);
  return backup;
}
