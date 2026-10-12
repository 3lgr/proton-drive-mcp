// F-12 / F-13: text that leaves this process (stderr log, error results) must not carry share links, link
// passwords, tokens or raw CLI output. One function, used by the logger and by the CLI-failure formatter.

const PUBLIC_LINK = /https?:\/\/[^\s"'<>)\]]*proton\.me\/urls\/[^\s"'<>)\]]*/gi;
const SECRET_FLAG = /(--(?:password|message|token|secret)[= ])("[^"]*"|'[^']*'|\S+)/gi;
const KEY_VALUE = /\b((?:password|passwd|pwd|secret|token|api[_-]?key|authorization|session(?:[_-]?id)?|cookie)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AUTH_HEADER = /\b(authorization\s*[:=]\s*)(?:(?:Bearer|Basic|Token)\s+)?\S+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function redact(text: string): string {
  return text
    .replace(PUBLIC_LINK, "[public link redacted]")
    .replace(SECRET_FLAG, "$1***")
    .replace(AUTH_HEADER, "$1***")
    .replace(KEY_VALUE, "$1***")
    .replace(BEARER, "$1 ***");
}
