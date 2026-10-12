// Boolean environment switches that RELAX a control are parsed strictly: exactly "1" or exactly "true".
// Empty, whitespace, "false", "no", "0", "on", "TRUE" or anything else means NOT enabled. A typo can never
// switch a protection off.
export function envFlag(name: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = env[name];
  return v === "1" || v === "true";
}

/** drive_write_file is off unless the operator turns it on: a model that can write files can plant things other programs trust. */
export const SYNC_WRITE_ENV = "PROTON_DRIVE_ENABLE_SYNC_WRITE";

/** Every opt-out that relaxes a control and is currently switched on (for `doctor` and logs). */
export const OPT_OUTS = [
  { env: "PROTON_DRIVE_ALLOW_ANY_LOCAL_PATH", relaxes: "the local-path allowlist (any local path outside the denylist is reachable)" },
  { env: "PROTON_DRIVE_ALLOW_SENSITIVE_PATHS", relaxes: "the credential and secret-name denylist" },
  { env: "PROTON_DRIVE_ALLOW_UNATTENDED_DESTRUCTIVE", relaxes: "fail-closed consent for irreversible tools on clients without elicitation" },
  { env: SYNC_WRITE_ENV, relaxes: "drive_write_file (off by default): the model may create or overwrite plain data files in the sync folder" },
] as const;

export function activeOptOuts(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const out: string[] = OPT_OUTS.filter((o) => envFlag(o.env, env)).map((o) => `${o.env}: ${o.relaxes}`);
  if (env["PROTON_DRIVE_SHARE_POLICY"] === "off") out.push("PROTON_DRIVE_SHARE_POLICY=off: the sharing policy (links need no password/expiry, admin invites allowed)");
  return out;
}
