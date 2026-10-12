// F-10: the proton-drive CLI gets only the environment it needs, not everything this process inherited
// (cloud keys, tokens and other tools' secrets sitting in the parent's environment). Extra names or prefixes
// (a trailing `*`) can be passed through with PROTON_DRIVE_PASS_ENV, comma-separated.
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

export function buildChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = (parent["PROTON_DRIVE_PASS_ENV"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const extraExact = new Set(extra.filter((e) => !e.endsWith("*")));
  const extraPrefix = extra.filter((e) => e.endsWith("*")).map((e) => e.slice(0, -1));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (EXACT.has(k) || PREFIXES.some((p) => k.startsWith(p)) || extraExact.has(k) || extraPrefix.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
