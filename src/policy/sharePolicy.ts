// F-06: what the MODEL may share, regardless of what the human approves case by case.
// PROTON_DRIVE_SHARE_POLICY      strict (default) | off
// PROTON_DRIVE_SHARE_ALLOWED_DOMAINS  comma-separated e-mail domains that invitations may target (unset = any)
// Applies to the MCP tools; the companion CLI is typed by a human and is not restricted by it.

export interface SharePolicy {
  readonly mode: "strict" | "off";
  readonly allowedDomains: readonly string[];
}

export const MAX_LINK_DAYS = 90; // Proton rejects links that expire further out
export const MIN_LINK_PASSWORD = 8;

export function loadSharePolicy(env: Readonly<Record<string, string | undefined>> = process.env): SharePolicy {
  const raw = (env["PROTON_DRIVE_SHARE_POLICY"] ?? "strict").trim().toLowerCase();
  const mode = raw === "off" ? "off" : "strict"; // anything unrecognised keeps the safe default
  const allowedDomains = (env["PROTON_DRIVE_SHARE_ALLOWED_DOMAINS"] ?? "")
    .split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return { mode, allowedDomains };
}

export interface LinkRequest { role: string; password?: string; expiration?: string }

export function checkPublicLink(policy: SharePolicy, r: LinkRequest, now: Date = new Date()): void {
  if (policy.mode === "off") return;
  const hint = "Set PROTON_DRIVE_SHARE_POLICY=off to lift this rule.";
  if (r.role !== "viewer") throw new Error(`share policy: a public link may only be 'viewer' (anyone with the URL would get ${r.role} access). ${hint}`);
  if (!r.password || r.password.length < MIN_LINK_PASSWORD) {
    throw new Error(`share policy: a public link needs a password of at least ${MIN_LINK_PASSWORD} characters. ${hint}`);
  }
  if (!r.expiration) throw new Error(`share policy: a public link needs an expiration date (at most ${MAX_LINK_DAYS} days ahead). ${hint}`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(r.expiration) || Number.isNaN(Date.parse(r.expiration))) {
    throw new Error("share policy: expiration must be an ISO date such as 2026-12-31");
  }
  const days = (Date.parse(r.expiration) - now.getTime()) / 86_400_000;
  if (days <= 0) throw new Error("share policy: the expiration date is in the past");
  if (days > MAX_LINK_DAYS + 1) throw new Error(`share policy: the expiration is more than ${MAX_LINK_DAYS} days ahead. ${hint}`);
}

export function checkInvite(policy: SharePolicy, email: string, role: string): void {
  if (policy.mode === "off") return;
  if (role === "admin") {
    throw new Error("share policy: the 'admin' role lets the invitee reshare, so it is not offered through the model. Use viewer or editor, or set PROTON_DRIVE_SHARE_POLICY=off.");
  }
  if (policy.allowedDomains.length === 0) return;
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (!policy.allowedDomains.includes(domain)) {
    throw new Error(`share policy: invitations are limited to these domains: ${policy.allowedDomains.join(", ")} (PROTON_DRIVE_SHARE_ALLOWED_DOMAINS).`);
  }
}
