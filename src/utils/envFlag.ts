import { parsePassEnv, MIN_PASS_PREFIX } from "./childEnv.js";

// Boolean environment switches that RELAX a control are parsed strictly: exactly "1" or exactly "true".
// Empty, whitespace, "false", "no", "0", "on", "TRUE" or anything else means NOT enabled. A typo can never
// switch a protection off.
export function envFlag(name: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[name];
  return v === "1" || v === "true";
}

/** Every opt-out that relaxes a control and is currently switched on (for `doctor` and logs). */
export const OPT_OUTS = [
  { env: "PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH", relaxes: "the local-path allowlist (any local path outside the denylist is reachable)" },
  { env: "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS", relaxes: "the credential and secret-name denylist" },
  { env: "PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE", relaxes: "fail-closed consent for irreversible tools on clients without elicitation" },
] as const;

export function activeOptOuts(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const out: string[] = OPT_OUTS.filter((o) => envFlag(o.env, env)).map((o) => `${o.env}: ${o.relaxes}`);
  const pass = parsePassEnv(env["PROTON_DRIVE_PASS_ENV"]);
  if (pass.exact.length + pass.prefixes.length > 0) {
    const names = [...pass.exact, ...pass.prefixes.map((p) => `${p}*`)].join(", ");
    out.push(`PROTON_DRIVE_PASS_ENV: the CLI also receives these variables from this process: ${names}`);
  }
  if (pass.refused.length > 0) out.push(`PROTON_DRIVE_PASS_ENV: refused as too broad (a prefix needs ${MIN_PASS_PREFIX}+ characters before the *): ${pass.refused.join(", ")}`);
  if (env["PROTON_DRIVE_SHARE_POLICY"] === "off") out.push("PROTON_DRIVE_SHARE_POLICY=off: the sharing policy (links need no password/expiry, admin invites allowed)");
  return out;
}
