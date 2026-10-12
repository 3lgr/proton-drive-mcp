// Derives the advertised tool surface (titles, annotations, gates, tiers) from the raw definitions.
import { logger } from "../utils/logger.js";
import { descriptionSuffix, needsConfirmedProp } from "../policy/gates.js";
import { TOOLS } from "./tools/index.js";
import type { JsonSchemaProp, ToolDef } from "./schema.js";

// ---- Tool surface: derived from TOOLS so the literal stays readable ----------
// Confirmation gates live in one table: src/policy/gates.ts.
export const PAGE_DEFAULTS: Record<string, number> = { drive_list: 200, drive_list_trash: 100, photos_list_timeline: 50, photos_list_album_photos: 100 };
const EXTRA_PROPS: Record<string, Record<string, JsonSchemaProp & { description: string }>> = {
  drive_info: { verbose: { type: "boolean", description: "Return the raw CLI node instead of the trimmed one (default false)." } },
  drive_copy: { newName: { type: "string", description: "Optional name for the copy (CLI --name). Required to copy an item into its own folder." } },
  photos_list_album_photos: { loadDetails: { type: "boolean", description: "Include name, mediaType, sizes, captureTime and tags (default false)." } },
};
// Replace/remove strategies are gated by `confirmed`, so the tools themselves are
// not advertised as destructive; trash is reversible via drive_restore.
const ANNOTATION_OVERRIDES: Record<string, Record<string, boolean>> = {
  drive_share_set_url: { destructiveHint: true, openWorldHint: true },
  drive_share_invite: { destructiveHint: false, openWorldHint: true },
  drive_upload: { destructiveHint: false },
  drive_download: { destructiveHint: false },
  photos_download: { destructiveHint: false },
  photos_upload: { destructiveHint: false },
  drive_trash: { destructiveHint: false, idempotentHint: true },
  drive_version: { openWorldHint: false },
  drive_read_file: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  drive_read_content: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};
const TOOL_TITLES: Record<string, string> = {
  drive_tree: "Show folder tree", drive_search: "Search files", drive_usage: "Storage usage report",
  drive_find_duplicates: "Find duplicate files", drive_sharing_audit: "Audit sharing",
  drive_sync_plan: "Plan local/Drive sync", drive_bulk_move: "Move many items", drive_bulk_trash: "Trash many items",
  drive_auth_status: "Check sign-in status", drive_auth_logout: "Sign out", drive_version: "CLI version",
  drive_list: "List folder", drive_info: "Get item info", drive_upload: "Upload to Drive", drive_download: "Download from Drive",
  drive_mkdir: "Create folder", drive_rename: "Rename item", drive_move: "Move item", drive_delete: "Delete permanently",
  drive_share_status: "Show sharing status", drive_list_trash: "List trash", drive_share_invite: "Invite to share",
  drive_share_revoke: "Revoke member access", drive_trash: "Move to trash", drive_restore: "Restore from trash",
  drive_empty_trash: "Empty trash", drive_copy: "Copy item", drive_list_invitations: "List invitations",
  drive_invitation_accept: "Accept invitation", drive_invitation_reject: "Reject invitation", drive_share_leave: "Leave shared item",
  drive_share_set_url: "Create or update public link", drive_share_remove_url: "Remove public link",
  drive_share_remove_all: "Remove all sharing", photos_list_albums: "List photo albums", photos_create_album: "Create photo album",
  photos_update_album: "Update photo album", photos_delete_album: "Delete photo album", photos_list_album_photos: "List album photos",
  photos_add_to_album: "Add photos to album", photos_remove_from_album: "Remove photo from album", photos_list_timeline: "List photo timeline",
  photos_download: "Download photo", photos_upload: "Upload photos", drive_read_file: "Read synced text file", drive_read_content: "Read file text",
};
// Hint for clients that cap tool-result size: these tools can legitimately return large payloads.
export const LARGE_RESULT_TOOLS = new Set(["drive_list", "drive_read_file", "drive_read_content"]);

export const TOOL_DEFS: ToolDef[] = TOOLS.map((t) => {
  const base = t as unknown as ToolDef;
  const properties: Record<string, JsonSchemaProp & { description?: string }> = { ...base.inputSchema.properties, ...(EXTRA_PROPS[base.name] ?? {}) };
  let description = base.description;
  if (base.name in PAGE_DEFAULTS) {
    properties.limit = { type: "integer", minimum: 1, maximum: 1000, description: `Max items to return (default ${PAGE_DEFAULTS[base.name]}).` };
    properties.offset = { type: "integer", minimum: 0, description: "Number of items to skip (default 0)." };
  }
  const confirmedProp = { type: "boolean", description: "Must be true; only after the user approved this exact action." };
  if (needsConfirmedProp(base.name)) {
    properties.confirmed = confirmedProp;
    description += descriptionSuffix(base.name) ?? "";
  }
  return {
    ...base,
    ...(TOOL_TITLES[base.name] ? { title: TOOL_TITLES[base.name] } : {}),
    description,
    inputSchema: { ...base.inputSchema, properties },
    annotations: { ...(base.annotations ?? {}), ...(ANNOTATION_OVERRIDES[base.name] ?? {}) },
  };
});

// Core tier (PROTON_DRIVE_TOOL_TIER=core): everyday tools only, to cut the tools/list
// payload every session pays for. Excluded on purpose: permanent deletion
// (drive_delete, drive_empty_trash), auth_logout, public links, invitations/invites,
// album management and the sync-file tools. Those stay full-tier only.
export const CORE_TOOL_NAMES = new Set([
  "drive_auth_status", "drive_version", // session check and CLI diagnostics
  "drive_list", "drive_info", "drive_list_trash", // reading
  "drive_read_content", // text of a Drive file, no download
  "drive_search", "drive_tree", // finding things without listing folder by folder
  "drive_mkdir", "drive_upload", "drive_download", // basic file I/O
  "drive_rename", "drive_move", "drive_copy", // reorganising
  "drive_trash", "drive_restore", // reversible removal
  "drive_share_status", // read-only sharing check
  "photos_list_timeline", "photos_download", // browse and fetch photos (read-only locally)
]);

export function resolveTier(raw: string | undefined): "full" | "core" {
  const v = (raw ?? "full").trim().toLowerCase();
  if (v === "full" || v === "core") return v;
  logger.warn('Unknown PROTON_DRIVE_TOOL_TIER; using "full" (valid: full, core). Value:', raw);
  return "full";
}

