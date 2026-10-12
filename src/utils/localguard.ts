import { realpathSync, lstatSync, mkdirSync, readlinkSync, statSync } from "node:fs";

// realpathSync.native asks the OS, so it also returns the on-disk case of every existing component.
const realpath = realpathSync.native;
import { homedir } from "node:os";
import { envFlag } from "./envFlag.js";
import { resolve, dirname, basename, join, relative, isAbsolute, sep, delimiter } from "node:path";

const HOME_DENY = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".npmrc", ".netrc", ".pgpass", ".config/gcloud", ".claude", ".claude.json",
  ".git-credentials", ".config/git/credentials", ".config/gh", ".azure", ".oci", ".config/op", ".op", ".password-store", ".vault-token",
  ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials", ".m2/settings-security.xml", ".config/rclone",
  ".terraform.d/credentials.tfrc.json", ".s3cfg", ".boto", ".zsh_history", ".bash_history", ".local/share/keyrings",
  // browser profiles: cookies, saved logins, session tokens
  ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge",
  "Library/Keychains", "Library/Application Support/Claude", "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox", "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge",
  "Library/Safari", "Library/Cookies",
  // places whose contents run or reconfigure things at login or on the next command
  "Library/LaunchAgents", "Library/Services", ".config/autostart", ".config/systemd", ".config/fish", ".config/git",
  ".oh-my-zsh/custom", ".local/share/applications", ".gitconfig", ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile",
];
const ABS_DENY = ["/etc", "/private/etc", "/var/root", "/Library/LaunchAgents", "/Library/LaunchDaemons", "/usr/local/bin", "/usr/bin", "/bin", "/sbin", "/usr/sbin"];
// Matched case-insensitively against a file's own name, anywhere. Note *.key also matches Keynote files: rename them,
// or set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1.
const NAME_DENY = [
  /^\.env(\..*)?$/, /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /^id_dsa/,
  /\.pem$/, /\.p12$/, /\.pfx$/, /\.key$/, /\.ppk$/, /\.jks$/, /\.keystore$/, /\.kdbx?$/, /\.keychain/,
  /^credentials(\.json)?$/, /^\.git-credentials$/, /^\.htpasswd$/, /^\.netrc$/, /^\.pgpass$/, /^\.npmrc$/, /^\.pypirc$/,
  /\.tfstate(\.backup)?$/,
];

// macOS (APFS/HFS+) and Windows volumes are normally case-insensitive and Unicode-normalisation-insensitive, but
// realpath does not canonicalise a tail that does not exist (and the JS realpath does not canonicalise case at
// all), so "~/.SSH" must still hit a denylist entry spelled "~/.ssh". Protected-location checks therefore compare
// folded paths; folding can only make a denylist stricter. Allowlist roots are compared exactly: folding there
// would be permissive on a case-sensitive volume.
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
const fold = (p: string): string => (CASE_INSENSITIVE_FS ? p.normalize("NFC").toLowerCase() : p);

function isInside(root: string, target: string, foldCase = false): boolean {
  const rel = foldCase ? relative(fold(root), fold(target)) : relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

/** Denylist containment: case-insensitive where the filesystem usually is. */
const isProtectedInside = (denied: string, target: string): boolean => isInside(denied, target, true);

/** realpath of the deepest existing ancestor + remaining segments; follows dangling symlinks manually. */
function realResolve(p: string, depth = 0): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      const real = realpath(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EACCES: an unreadable ancestor (e.g. /var/root) can't be resolved; keep walking up so the denylist still matches by path.
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw e;
      let linkTarget: string | null = null;
      try {
        if (lstatSync(cur).isSymbolicLink()) linkTarget = readlinkSync(cur);
      } catch {
        /* not present */
      }
      if (linkTarget !== null) {
        if (depth > 16) throw new Error(`too many symlink levels: ${p}`);
        const next = resolve(dirname(cur), linkTarget);
        const base = realResolve(next, depth + 1);
        return rest.length ? join(base, ...rest.reverse()) : base;
      }
      const parent = dirname(cur);
      if (parent === cur) return rest.length ? join(cur, ...rest.reverse()) : cur;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** True unless PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1. A LOCAL_ROOT allowlist narrows access further; it never switches the denylist off. */
function denylistEnabled(): boolean {
  return !envFlag("PROTON_DRIVE_ALLOW_SENSITIVE_PATHS");
}

/** The protected locations as absolute paths (lexical and resolved). Independent of any opt-out. */
function sensitiveSet(): Set<string> {
  const home = homedir();
  const denied = new Set<string>();
  for (const rel of HOME_DENY) {
    denied.add(resolve(home, rel));
    denied.add(realResolve(join(home, rel)));
  }
  for (const a of ABS_DENY) {
    denied.add(a);
    denied.add(realResolve(a));
  }
  return denied;
}

/** Protected absolute locations, or null when the denylist is off (PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1). */
function deniedPaths(): Set<string> | null {
  if (!denylistEnabled()) return null;
  return sensitiveSet();
}

function rootsEnv(): string[] {
  const env = process.env["PROTON_DRIVE_LOCAL_ROOT"];
  return env ? env.split(delimiter).filter((r) => r.trim() !== "") : [];
}

// ---- allowlist: where local files may be read from and written to --------------------------------------------------
// Default: ONE dedicated folder created by the server (~/ProtonDriveMCP, 0700). PROTON_DRIVE_LOCAL_ROOT replaces it.
// PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH=1 removes the allowlist (the denylist below remains as defence in depth).
// The denylist can never be complete; the allowlist is the control.
export const ANY_LOCAL_ENV = "PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH";
export const DEFAULT_ROOT_NAME = "ProtonDriveMCP";

export function anyLocalPathAllowed(): boolean {
  return envFlag(ANY_LOCAL_ENV);
}

/**
 * A root must exist, must not be a symlink, and must be neither "/", nor the home folder, nor contain (or sit inside)
 * a protected location. Returns the realpath.native-resolved root.
 */
export function validateRoot(raw: string, label: string): string {
  const abs = resolve(raw);
  let st;
  try { st = lstatSync(abs); }
  catch { throw new Error(`${label} does not exist: ${raw}. Create the folder first.`); }
  if (st.isSymbolicLink()) throw new Error(`${label} is a symlink, which is not accepted as a root: ${raw}`);
  if (!st.isDirectory()) throw new Error(`${label} is not a folder: ${raw}`);
  const real = realpath(abs);
  if (real === sep || real === resolve(homedir()) || real === realResolve(homedir())) {
    throw new Error(`${label} must not be "/" or your home folder: ${raw}`);
  }
  if (denylistEnabled()) {
    for (const d of sensitiveSet()) {
      if (isProtectedInside(real, d) || isProtectedInside(d, real)) {
        throw new Error(`${label} contains or sits inside a protected location (${d}); choose a dedicated folder: ${raw}`);
      }
    }
  }
  return real;
}

function ensureDefaultRoot(): string {
  const dir = join(homedir(), DEFAULT_ROOT_NAME);
  try {
    lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { mode: 0o700 });
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`the default local folder ${dir} is a symlink; remove it or set PROTON_DRIVE_LOCAL_ROOT`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`the default local folder ${dir} is not owned by you`);
  return validateRoot(dir, `the default local folder ${dir}`);
}

/** Roots in force. An empty list means "no allowlist" (only with PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH=1). */
export function activeRoots(): string[] {
  const configured = rootsEnv();
  if (configured.length > 0) return configured.map((r) => validateRoot(r, "PROTON_DRIVE_LOCAL_ROOT entry"));
  if (anyLocalPathAllowed()) return [];
  return [ensureDefaultRoot()];
}

/** The allowed root that contains `realPath` (already resolved), or undefined when there is none / no allowlist. */
export function allowedRootFor(realPath: string): string | undefined {
  return activeRoots().find((r) => isInside(r, realPath));
}

/** Describes the allowlist for messages and `doctor`. */
export function describeRoots(): { mode: "configured" | "default" | "any"; roots: string[] } {
  if (rootsEnv().length > 0) return { mode: "configured", roots: rootsEnv() };
  if (anyLocalPathAllowed()) return { mode: "any", roots: [] };
  return { mode: "default", roots: [join(homedir(), DEFAULT_ROOT_NAME)] };
}

/**
 * The one entry point every local file operation goes through (upload, download, photos, sync plan, read_file/
 * write_file roots): the real path of `absPath` must be inside an allowed root. Returns that real path.
 */
export function resolveAllowedLocal(absPath: string): string {
  const real = realResolve(resolve(absPath));
  const roots = activeRoots();
  if (roots.length > 0 && !roots.some((r) => isInside(r, real))) {
    const where = rootsEnv().length > 0
      ? "PROTON_DRIVE_LOCAL_ROOT"
      : `the default local folder ~/${DEFAULT_ROOT_NAME} (set PROTON_DRIVE_LOCAL_ROOT to choose another, or ${ANY_LOCAL_ENV}=1 to lift the allowlist)`;
    throw new Error(`local path is outside ${where}: ${absPath}`);
  }
  return real;
}

/** A sync folder given by the operator (PROTON_DRIVE_SYNC_PATH) must be a usable root too. */
export function assertSyncRootUsable(raw: string): string {
  return validateRoot(raw, "PROTON_DRIVE_SYNC_PATH");
}

const nameDenied = (name: string): boolean => NAME_DENY.some((re) => re.test(name.toLowerCase()));

/** True when the denylist is in force (PROTON_DRIVE_ALLOW_SENSITIVE_PATHS is not exactly "1"/"true"). */
export const sensitiveRulesEnabled = denylistEnabled;

/** A file name that looks like a credential or secret (.env*, id_*, *.pem, *.key, ...), case-insensitive. */
export const isSecretName = nameDenied;

/**
 * True when `fullPath` is a secret-file name or sits in a protected location (~/.ssh, ~/.aws, shell rc files...).
 * Unlike isProtectedEntry it does NOT apply the local allowlist: the sync folder has its own containment guard.
 */
export function isSensitiveLocation(fullPath: string, name: string): boolean {
  const denied = deniedPaths();
  if (!denied) return false;
  if (nameDenied(name)) return true;
  const lexical = resolve(fullPath);
  const real = realResolve(lexical);
  for (const d of denied) if (isProtectedInside(d, real) || isProtectedInside(d, lexical)) return true;
  return false;
}

/**
 * True when a directory entry must not be read during a recursive scan: a secret-file name, a protected path, or
 * (with PROTON_DRIVE_LOCAL_ROOT) a path that resolves outside the allowed roots. Names and paths are always
 * checked unless PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1.
 */
export function isProtectedEntry(fullPath: string, name: string): boolean {
  const lexical = resolve(fullPath);
  const real = realResolve(lexical);
  const roots = activeRoots();
  if (roots.length > 0 && !roots.some((r) => isInside(r, real))) return true;
  const denied = deniedPaths();
  if (!denied) return false;
  if (nameDenied(name)) return true;
  for (const d of denied) if (isProtectedInside(d, real) || isProtectedInside(d, lexical)) return true;
  return false;
}

/**
 * `scan: true` is for operations that READ a directory recursively (sync plan, folder upload): the target must
 * not contain a protected location either. Leave it off for write destinations such as download folders.
 */
export function assertLocalPathAllowed(absPath: string, opts: { scan?: boolean } = {}): void {
  const lexical = resolve(absPath);
  const real = realResolve(lexical);

  resolveAllowedLocal(absPath); // the allowlist first; the denylist below is defence in depth

  const denied = deniedPaths();
  if (!denied) return;

  for (const d of denied) {
    if (isProtectedInside(d, real) || isProtectedInside(d, lexical)) {
      throw new Error(
        `local path is in a protected location and cannot be used: ${absPath} ` +
          `(set PROTON_DRIVE_LOCAL_ROOT to allow specific folders, or PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
      );
    }
  }
  for (const name of [basename(lexical), basename(real)]) {
    if (nameDenied(name)) {
      throw new Error(
        `local path looks like a credential/secret file and cannot be used: ${absPath} ` +
          `(set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
      );
    }
  }
  if (opts.scan && isDirectory(real)) {
    for (const d of denied) {
      if (isProtectedInside(real, d) || isProtectedInside(lexical, d)) {
        throw new Error(
          `local folder contains protected locations and cannot be scanned: ${absPath}; pick a subfolder ` +
            `(set PROTON_DRIVE_LOCAL_ROOT to allow specific folders, or PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
        );
      }
    }
  }
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
