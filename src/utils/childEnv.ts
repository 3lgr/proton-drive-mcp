// F-10: the proton-drive CLI gets only the environment it needs, not everything this process inherited
// (cloud keys, tokens and other tools' secrets sitting in the parent's environment). Extra names or prefixes
// (a trailing `*`, at least 3 characters before it) can be passed through with PROTON_DRIVE_PASS_ENV, comma-separated.
// `*` alone and short prefixes are refused: they would hand over the whole environment (N-08).
const EXACT = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR",
  "TMPDIR", "TEMP", "TMP",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  // keyring access on Linux desktops
  "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY",
  // Windows
  "SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "USERNAME",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "ProgramData", "PROGRAMFILES", "ProgramFiles", "COMPUTERNAME",
]);
// PROTON_DRIVE_* only: other Proton products' variables (PROTON_PASS_*, PROTON_VPN_*...) are not for this CLI.
const PREFIXES = ["LC_", "XDG_", "PROTON_DRIVE_"];

/** Shortest prefix (before the `*`) that PROTON_DRIVE_PASS_ENV accepts: "*" or "A*" would pass the whole environment. */
export const MIN_PASS_PREFIX = 3;

export interface PassEnv { exact: string[]; prefixes: string[]; refused: string[] }

/** Splits PROTON_DRIVE_PASS_ENV into exact names, accepted prefixes and refused (too broad) entries. */
export function parsePassEnv(raw: string | undefined): PassEnv {
  const out: PassEnv = { exact: [], prefixes: [], refused: [] };
  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!entry.includes("*")) { out.exact.push(entry); continue; }
    const prefix = entry.slice(0, -1);
    // only a single trailing `*`, after a real prefix of word characters
    if (entry.endsWith("*") && prefix.length >= MIN_PASS_PREFIX && /^[A-Za-z0-9_.-]+$/.test(prefix)) out.prefixes.push(prefix);
    else out.refused.push(entry);
  }
  return out;
}

export function buildChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { exact, prefixes } = parsePassEnv(parent["PROTON_DRIVE_PASS_ENV"]);
  const extraExact = new Set(exact);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (EXACT.has(k) || PREFIXES.some((p) => k.startsWith(p)) || extraExact.has(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
