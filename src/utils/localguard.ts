import { realpathSync, lstatSync, readlinkSync, statSync } from "node:fs";

// realpathSync.native asks the OS, so it also returns the on-disk case of every existing component.
const realpath = realpathSync.native;
import { homedir } from "node:os";
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
];
const ABS_DENY = ["/etc", "/private/etc", "/var/root"];
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
  return process.env["PROTON_DRIVE_ALLOW_SENSITIVE_PATHS"] !== "1";
}

/** Protected absolute locations, or null when the denylist is off (PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1). */
function deniedPaths(): Set<string> | null {
  if (!denylistEnabled()) return null;
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

function rootsEnv(): string[] {
  const env = process.env["PROTON_DRIVE_LOCAL_ROOT"];
  return env ? env.split(delimiter).filter((r) => r.trim() !== "") : [];
}

const nameDenied = (name: string): boolean => NAME_DENY.some((re) => re.test(name.toLowerCase()));

/**
 * True when a directory entry must not be read during a recursive scan: a secret-file name, a protected path, or
 * (with PROTON_DRIVE_LOCAL_ROOT) a path that resolves outside the allowed roots. Names and paths are always
 * checked unless PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1.
 */
export function isProtectedEntry(fullPath: string, name: string): boolean {
  const lexical = resolve(fullPath);
  const real = realResolve(lexical);
  const roots = rootsEnv();
  if (roots.length > 0 && !roots.some((r) => isInside(realResolve(r), real))) return true;
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

  const roots = rootsEnv();
  if (roots.length > 0 && !roots.some((r) => isInside(realResolve(r), real))) {
    throw new Error(`local path is outside PROTON_DRIVE_LOCAL_ROOT: ${absPath}`);
  }

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
