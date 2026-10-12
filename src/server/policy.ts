// The registry every tool must appear in. A tool without a policy is not served: startup fails (default deny).
//
//   class    read | write | destructive | external   (what the tool can do)
//   consent  none        nothing to ask (reads, reversible writes)
//            dispatcher  the dispatcher validates the arguments and obtains consent BEFORE the handler runs; the
//                        handler receives the validated, normalised arguments
//            handler     consent depends on state only the handler can see (conflict strategy, destination shared,
//                        file exists, bulk apply). The handler gets a guarded `drive`: a mutating call made before
//                        the gate was evaluated throws, so forgetting the gate fails closed.
import { GATES, type Args } from "../policy/gates.js";
import { checkInvite, checkPublicLink, type SharePolicy } from "../policy/sharePolicy.js";
import { validateRemotePath, validateEmail, validateFlagValue } from "../utils/validation.js";
import { approvalField } from "../policy/untrusted.js";
import type { DriveService } from "../services/drive.js";

export type ToolClass = "read" | "write" | "destructive" | "external";
export type Consent = "none" | "dispatcher" | "handler";

export interface PolicyContext {
  readonly drive: DriveService;
  readonly sharePolicy: SharePolicy;
  readonly canElicit: () => boolean;
}

export interface ToolPolicy {
  readonly class: ToolClass;
  readonly consent: Consent;
  /** consent "dispatcher": validated, normalised arguments (throws on anything invalid; nothing is asked or run). */
  readonly validate?: (a: Args, ctx: PolicyContext) => Args | Promise<Args>;
  /** consent "dispatcher": the human-facing text; default is the gate table's consequence plus the arguments. */
  readonly prompt?: (v: Args, ctx: PolicyContext) => string | Promise<string | undefined> | undefined;
  /** consent "handler": true when a mutating call needs the gate to have been evaluated for these arguments. */
  readonly gateRequired?: (a: Args) => boolean;
  /**
   * Local paths this tool touches. The DISPATCHER resolves each through the local allowlist before the handler runs
   * (the same check for every group; handlers keep their own validation as a second layer, never as the only one).
   */
  readonly local?: { readonly args?: readonly string[]; readonly listArgs?: readonly string[]; readonly syncRoot?: boolean };
}

const none = (cls: ToolClass): ToolPolicy => ({ class: cls, consent: "none" });
const handler = (cls: ToolClass, gateRequired: (a: Args) => boolean, local?: ToolPolicy["local"]): ToolPolicy =>
  ({ class: cls, consent: "handler", gateRequired, ...(local ? { local } : {}) });
const str = (v: unknown, label: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${label} must be a non-empty string`);
  return v;
};
const albumPath = (v: unknown): string => {
  const p = validateRemotePath(v);
  if (!p.startsWith("/albums/")) throw new Error("albumPath must start with /albums/");
  return p;
};
const photoPath = (v: unknown): string => {
  const p = validateRemotePath(v);
  if (!p.startsWith("/photos/")) throw new Error("photoPath must start with /photos/");
  return p;
};

export const TOOL_POLICY: Readonly<Record<string, ToolPolicy>> = {
  // ---- reads
  drive_auth_status: none("read"), drive_version: none("read"), drive_list: none("read"), drive_info: none("read"),
  drive_tree: none("read"), drive_search: none("read"), drive_list_trash: none("read"), drive_share_status: none("read"),
  drive_list_invitations: none("read"), photos_list_albums: none("read"), photos_list_album_photos: none("read"),
  photos_list_timeline: none("read"), drive_read_content: none("read"), drive_read_file: { class: "read", consent: "none", local: { syncRoot: true } },
  drive_sync_plan: { class: "read", consent: "none", local: { args: ["localPath"] } }, drive_usage: none("read"), drive_find_duplicates: none("read"), drive_sharing_audit: none("read"),

  // ---- reversible writes without a gate
  drive_mkdir: none("write"), drive_rename: none("write"), drive_trash: none("write"), drive_restore: none("write"),
  photos_create_album: none("write"), photos_update_album: none("write"),
  photos_upload: { class: "write", consent: "none", local: { listArgs: ["localPaths"] } },

  // ---- writes whose consent depends on state seen by the handler
  drive_upload: handler("write", (a) => GATES.drive_upload!.applies(a), { args: ["localPath"] }),
  drive_download: handler("write", (a) => GATES.drive_download!.applies(a), { args: ["localPath"] }),
  photos_download: handler("write", (a) => GATES.photos_download!.applies(a), { args: ["localFolder"] }),
  photos_add_to_album: handler("write", () => true),
  drive_move: handler("write", () => true),
  drive_copy: handler("write", () => true),
  drive_write_file: handler("write", () => true, { syncRoot: true }),
  drive_bulk_move: handler("write", (a) => a.confirmed === true),
  drive_bulk_trash: handler("write", (a) => a.confirmed === true),

  // ---- consent first, always
  drive_delete: {
    class: "destructive", consent: "dispatcher",
    validate: (a) => {
      const path = a.path === undefined ? undefined : validateRemotePath(a.path);
      const uid = a.uid ? validateFlagValue(a.uid, "uid") : undefined;
      if (!path && !uid) throw new Error("Provide path or uid (from drive_list_trash).");
      return { ...a, ...(path ? { path } : {}), ...(uid ? { uid } : {}) };
    },
    prompt: (v) => `drive_delete needs your approval. It ${GATES.drive_delete!.consequence}\nTarget: ${approvalField(v.path ?? `uid ${String(v.uid)}`)}`,
  },
  drive_empty_trash: { class: "destructive", consent: "dispatcher", validate: (a) => ({ ...a }) },
  drive_auth_logout: { class: "destructive", consent: "dispatcher", validate: (a) => ({ ...a }) },
  photos_delete_album: { class: "destructive", consent: "dispatcher", validate: (a) => ({ ...a, albumPath: albumPath(a.albumPath) }) },
  photos_remove_from_album: {
    class: "destructive", consent: "dispatcher",
    validate: (a) => ({ ...a, albumPath: albumPath(a.albumPath), photoPath: photoPath(a.photoPath) }),
  },
  drive_invitation_reject: { class: "destructive", consent: "dispatcher", validate: (a) => ({ ...a, uid: validateFlagValue(str(a.uid, "uid"), "uid") }) },
  drive_invitation_accept: {
    class: "external", consent: "dispatcher",
    validate: (a) => ({ ...a, uid: validateFlagValue(str(a.uid, "uid"), "uid") }),
    // the human decides on who sends what, not on an opaque uid (only a client that can show the prompt needs the lookup)
    prompt: async (v, ctx) => {
      if (!ctx.canElicit()) return undefined;
      const inv = (await ctx.drive.listInvitations()).find((i) => i.uid === v.uid);
      if (!inv) throw new Error("No pending invitation with that uid. Call drive_list_invitations for the current ones.");
      return `drive_invitation_accept needs your approval. It ${GATES.drive_invitation_accept!.consequence}\n` +
        `from: ${approvalField(inv.invitedByEmail)}\nitem: ${approvalField(inv.nodeName)} (${inv.nodeType})\nrole: ${inv.role}\nuid: ${approvalField(v.uid)}`;
    },
  },
  drive_share_invite: {
    class: "external", consent: "dispatcher",
    validate: (a, ctx) => {
      if (typeof a.role !== "string") throw new Error("role must be a string: viewer, editor, or admin");
      const path = validateRemotePath(a.path);
      const { email, role } = checkInvite(ctx.sharePolicy, validateEmail(a.email), a.role);
      return { ...a, path, email, role };
    },
  },
  drive_share_revoke: { class: "external", consent: "dispatcher", validate: (a) => ({ ...a, path: validateRemotePath(a.path), email: validateEmail(a.email) }) },
  drive_share_set_url: {
    class: "external", consent: "dispatcher",
    validate: (a, ctx) => {
      const path = validateRemotePath(a.path);
      const role = typeof a.role === "string" ? a.role : "viewer";
      if (!["viewer", "editor"].includes(role)) throw new Error("role must be viewer or editor");
      const password = typeof a.password === "string" && a.password ? validateFlagValue(a.password, "password") : undefined;
      const expiration = typeof a.expiration === "string" && a.expiration ? validateFlagValue(a.expiration, "expiration") : undefined;
      checkPublicLink(ctx.sharePolicy, { role, password, expiration });
      return { ...a, path, role, ...(password ? { password } : {}), ...(expiration ? { expiration } : {}) };
    },
    prompt: (v) => `drive_share_set_url needs your approval. It ${GATES.drive_share_set_url!.consequence}\n` +
      `path: ${approvalField(v.path)}\nrole: ${String(v.role)}\npassword: ${v.password ? "[set]" : "[none]"}\nexpiration: ${v.expiration ? approvalField(v.expiration) : "[none]"}`,
  },
  drive_share_remove_url: { class: "external", consent: "dispatcher", validate: (a) => ({ ...a, path: validateRemotePath(a.path) }) },
  drive_share_remove_all: { class: "external", consent: "dispatcher", validate: (a) => ({ ...a, path: validateRemotePath(a.path) }) },
  drive_share_leave: { class: "external", consent: "dispatcher", validate: (a) => ({ ...a, path: validateRemotePath(a.path) }) },
};

/** DriveService methods that change anything (remote or local). Used by the guarded drive handed to handlers. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "upload", "download", "mkdir", "rename", "move", "delete", "trash", "restore", "emptyTrash", "copy",
  "shareInvite", "shareRevoke", "shareRemove", "shareRemoveAll", "shareSetUrl", "shareRemoveUrl", "shareLeave",
  "invitationAccept", "invitationReject", "authLogout", "createAlbum", "updateAlbum", "deleteAlbum", "addPhotoToAlbum",
  "removePhotoFromAlbum", "photoDownload", "photoUpload", "bulkMove", "bulkTrash",
]);

/**
 * Startup invariant: tools, handlers and policies are the same set; destructive and external tools can never run
 * without consent. Throws (the server does not start, the test fails) otherwise.
 */
export function assertRegistryComplete(
  toolNames: readonly string[], handlerNames: readonly string[], policies: Readonly<Record<string, ToolPolicy>> = TOOL_POLICY,
): void {
  const problems: string[] = [];
  const tools = new Set(toolNames);
  const handlers = new Set(handlerNames);
  for (const n of tools) {
    if (!Object.hasOwn(policies, n)) problems.push(`tool ${n} has no policy (default deny)`);
    if (!handlers.has(n)) problems.push(`tool ${n} has no handler`);
  }
  for (const n of handlers) if (!tools.has(n)) problems.push(`handler ${n} has no tool definition`);
  for (const n of Object.keys(policies)) if (!tools.has(n)) problems.push(`policy ${n} has no tool definition`);
  for (const [n, p] of Object.entries(policies)) {
    if ((p.class === "destructive" || p.class === "external") && p.consent === "none") problems.push(`${n} is ${p.class} but declares no consent`);
    if (p.consent !== "none" && !Object.hasOwn(GATES, n)) problems.push(`${n} requires consent but has no entry in the gate table`);
    if (p.consent === "dispatcher" && !p.validate) problems.push(`${n} obtains consent in the dispatcher but has no validator`);
    if (p.consent === "dispatcher" && Object.hasOwn(GATES, n) && !GATES[n]!.applies({})) {
      problems.push(`${n} obtains consent in the dispatcher but its gate is conditional`);
    }
    if (p.consent === "handler" && !p.gateRequired) problems.push(`${n} leaves consent to the handler without saying when it is required`);
  }
  if (problems.length) throw new Error(`tool registry is inconsistent:\n- ${problems.join("\n- ")}`);
}
