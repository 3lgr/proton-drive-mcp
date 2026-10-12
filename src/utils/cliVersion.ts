/** CLI major.minor versions this server is tested against (live-tested: CLI 0.8.0 / SDK js 0.21.0, CLI 0.9.0 / SDK js 0.22.2). */
export const TESTED_CLI: readonly string[] = ["0.8", "0.9"];
/** Human form of TESTED_CLI for messages: "0.8.x, 0.9.x". */
export const TESTED_CLI_LABEL = TESTED_CLI.map((v) => `${v}.x`).join(", ");
export const ISSUES_URL = "https://github.com/3lgr/proton-drive-mcp/issues";

/** Extracts the CLI's "major.minor" from `proton-drive version` output ("Proton Drive CLI cli-drive@0.8.0+abc"), or undefined. */
export function parseCliMajorMinor(text: string): string | undefined {
  const m = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").match(/Proton Drive CLI\s+\S*?(\d+\.\d+)\.\d+/);
  return m?.[1];
}

/** Returns a warning message when the CLI version is not in the tested list or is unreadable; undefined when it is listed. */
export function cliCompatWarning(text: string): string | undefined {
  const mm = parseCliMajorMinor(text);
  if (!mm) return `Could not read the proton-drive CLI version. Tested with ${TESTED_CLI_LABEL}; behaviour of other versions is unverified — report issues at ${ISSUES_URL}`;
  if (!TESTED_CLI.includes(mm)) return `proton-drive CLI ${mm}.x found. Tested with ${TESTED_CLI_LABEL}; behaviour of other versions is unverified — report issues at ${ISSUES_URL}`;
  return undefined;
}
