// F-06: what the MODEL may share, regardless of what the human approves case by case.
// PROTON_DRIVE_SHARE_POLICY      strict (default) | off
// PROTON_DRIVE_SHARE_ALLOWED_DOMAINS  comma-separated e-mail domains that invitations may target (unset = any)
// Applies to the MCP tools; the companion CLI is typed by a human and is not restricted by it.

import { canonicalDomain, validateEmail } from "../utils/validation.js";

export interface SharePolicy {
  readonly mode: "strict" | "off";
  readonly allowedDomains: readonly string[];
}

export const MAX_LINK_DAYS = 90; // Proton rejects links that expire further out
export const MIN_LINK_PASSWORD = 8;

export function loadSharePolicy(env: Readonly<Record<string, string | undefined>> = process.env): SharePolicy {
  const raw = (env["PROTON_DRIVE_SHARE_POLICY"] ?? "strict").trim().toLowerCase();
  const mode = raw === "off" ? "off" : "strict"; // anything unrecognised keeps the safe default
  // Entries are compared as punycode, exactly. A leading dot (".corp.com") is the only way to also admit subdomains.
  const allowedDomains: string[] = [];
  for (const raw of (env["PROTON_DRIVE_SHARE_ALLOWED_DOMAINS"] ?? "").split(",")) {
    const entry = raw.trim().replace(/^@/, "");
    if (!entry) continue;
    const suffix = entry.startsWith(".");
    const d = canonicalDomain(suffix ? entry.slice(1) : entry);
    if (!d) throw new Error(`PROTON_DRIVE_SHARE_ALLOWED_DOMAINS has an invalid entry: ${JSON.stringify(entry)}`);
    allowedDomains.push(suffix ? `.${d}` : d);
  }
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

export const INVITE_ROLES = ["viewer", "editor", "admin"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/**
 * Validates an invitation and returns the exact values to pass on: canonical e-mail, lower-case role. Throws for
 * anything the strict parser does not recognise (default deny).
 */
export function checkInvite(policy: SharePolicy, rawEmail: string, rawRole: string): { email: string; role: InviteRole } {
  const email = validateEmail(rawEmail);
  const role = String(rawRole).toLowerCase();
  if (!(INVITE_ROLES as readonly string[]).includes(role)) throw new Error("share policy: role must be viewer, editor or admin");
  if (policy.mode === "off") return { email, role: role as InviteRole };
  if (role === "admin") {
    throw new Error("share policy: the 'admin' role lets the invitee reshare, so it is not offered through the model. Use viewer or editor, or set PROTON_DRIVE_SHARE_POLICY=off.");
  }
  if (policy.allowedDomains.length > 0) {
    const domain = email.slice(email.indexOf("@") + 1);
    const ok = policy.allowedDomains.some((a) => (a.startsWith(".") ? domain.endsWith(a) : domain === a));
    if (!ok) throw new Error(`share policy: invitations are limited to these domains: ${policy.allowedDomains.join(", ")} (PROTON_DRIVE_SHARE_ALLOWED_DOMAINS).`);
  }
  return { email, role: role as InviteRole };
}

// Default deny: every tool must be classified. A tool that can create or widen exposure goes through the policy
// above; the test suite fails when a tool exists that is in neither list.
export const EXPOSURE_TOOLS: ReadonlySet<string> = new Set(["drive_share_invite", "drive_share_set_url"]);
export const NON_EXPOSING_TOOLS: ReadonlySet<string> = new Set([
  "drive_auth_status", "drive_auth_logout", "drive_version", "drive_list", "drive_info", "drive_tree", "drive_search", "drive_upload",
  "drive_download", "drive_mkdir", "drive_rename", "drive_move", "drive_delete", "drive_share_status", "drive_list_trash", "drive_share_revoke",
  "drive_trash", "drive_restore", "drive_empty_trash", "drive_copy", "drive_list_invitations", "drive_invitation_accept",
  "drive_invitation_reject", "drive_share_leave", "drive_share_remove_url", "drive_share_remove_all", "photos_list_albums",
  "photos_create_album", "photos_update_album", "photos_delete_album", "photos_list_album_photos", "photos_add_to_album",
  "photos_remove_from_album", "photos_list_timeline", "photos_download", "photos_upload", "drive_read_content", "drive_read_file",
  "drive_write_file", "drive_sync_plan", "drive_bulk_move", "drive_bulk_trash", "drive_usage", "drive_find_duplicates", "drive_sharing_audit",
]);
