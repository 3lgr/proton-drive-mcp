// Handlers: Sharing, public links and invitations.
import { validateRemotePath, validateMessage } from "../../utils/validation.js";
import type { Handler } from "../context.js";
import { ok } from "../result.js";

export const sharingHandlers: Record<string, Handler> = {
  drive_share_status: async (a, { drive }) => {
    return ok(await drive.shareStatus(validateRemotePath(a.path)));
  },
  drive_share_invite: async (a, { drive }) => {
    // consent and validation happened in the dispatcher (src/server/policy.ts); `a` is canonical
    const email = a.email as string;
    const role = a.role as "viewer" | "editor" | "admin";
    const inviteMsg = typeof a.message === "string" ? validateMessage(a.message) : undefined;
    await drive.shareInvite(a.path as string, email, role, inviteMsg);
    return ok({ message: `Invited ${email} as ${role}.` });
  },
  drive_share_revoke: async (a, { drive }) => {
    await drive.shareRevoke(a.path as string, a.email as string);
    return ok({ message: `Revoked access for ${a.email as string}.` });
  },
  drive_list_invitations: async (_a, { drive }) => {
    return ok(await drive.listInvitations());
  },
  drive_invitation_accept: async (a, { drive }) => {
    await drive.invitationAccept(a.uid as string);
    return ok({ message: "Invitation accepted." });
  },
  drive_invitation_reject: async (a, { drive }) => {
    await drive.invitationReject(a.uid as string);
    return ok({ message: "Invitation rejected." });
  },
  drive_share_leave: async (a, { drive }) => {
    await drive.shareLeave(a.path as string);
    return ok({ message: `Left shared folder: ${a.path as string}` });
  },
  drive_share_set_url: async (a, { drive }) => {
    const link = await drive.shareSetUrl(a.path as string, a.role as "viewer" | "editor", a.password as string | undefined, a.expiration as string | undefined);
    return ok(link);
  },
  drive_share_remove_url: async (a, { drive }) => {
    await drive.shareRemoveUrl(a.path as string);
    return ok({ message: `Public link removed: ${a.path as string}` });
  },
  drive_share_remove_all: async (a, { drive }) => {
    const removeAllPath = a.path as string;
    const removeAll = await drive.shareRemoveAll(removeAllPath);
    const linkNote = removeAll.publicLink ? " A public link is still active — anyone with it keeps access; remove it with drive_share_remove_url." : "";
    return ok({ message: (removeAll.removed === 0 ? `Nothing to remove: ${removeAllPath} has no members or pending invitations.` : `Removed all members and invitations (${removeAll.removed}) from: ${removeAllPath}.`) + linkNote });
  },
};
