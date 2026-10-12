// Handlers: Sharing, public links and invitations.
import { validateRemotePath, validateEmail, validateMessage, validateFlagValue } from "../../utils/validation.js";
import { checkInvite, checkPublicLink } from "../../policy/sharePolicy.js";
import type { Handler } from "../context.js";
import { ok, fail } from "../result.js";

export const sharingHandlers: Record<string, Handler> = {
  drive_share_status: async (a, { drive }) => {
    return ok(await drive.shareStatus(validateRemotePath(a.path)));
  },
  drive_share_invite: async (a, { drive, gate, sharePolicy }) => {
    if (typeof a.role !== "string") return fail("role must be a string: viewer, editor, or admin");
    const invitePath = validateRemotePath(a.path);
    // F-06: one strict parse; the canonical e-mail and lower-case role are what is shown, checked and sent.
    const { email, role } = checkInvite(sharePolicy, validateEmail(a.email), a.role);
    const inviteMsg = typeof a.message === "string" ? validateMessage(a.message) : undefined;
    await gate("drive_share_invite", { ...a, email, role });
    await drive.shareInvite(invitePath, email, role, inviteMsg);
    return ok({ message: `Invited ${email} as ${role}.` });
  },
  drive_share_revoke: async (a, { drive, gate }) => {
    const revokeEmail = validateEmail(a.email);
    const revokePath = validateRemotePath(a.path);
    await gate("drive_share_revoke", a);
    await drive.shareRevoke(revokePath, revokeEmail);
    return ok({ message: `Revoked access for ${revokeEmail}.` });
  },
  drive_list_invitations: async (_a, { drive }) => {
    return ok(await drive.listInvitations());
  },
  drive_invitation_accept: async (a, { drive, gate }) => {
    if (typeof a.uid !== "string" || !a.uid) return fail("uid must be a non-empty string");
    const acceptUid = validateFlagValue(a.uid, "uid");
    await gate("drive_invitation_accept", a);
    await drive.invitationAccept(acceptUid);
    return ok({ message: "Invitation accepted." });
  },
  drive_invitation_reject: async (a, { drive, gate }) => {
    if (typeof a.uid !== "string" || !a.uid) return fail("uid must be a non-empty string");
    const rejectUid = validateFlagValue(a.uid, "uid");
    await gate("drive_invitation_reject", a);
    await drive.invitationReject(rejectUid);
    return ok({ message: "Invitation rejected." });
  },
  drive_share_leave: async (a, { drive, gate }) => {
    const leavePath = validateRemotePath(a.path);
    await gate("drive_share_leave", a);
    await drive.shareLeave(leavePath);
    return ok({ message: `Left shared folder: ${leavePath}` });
  },
  drive_share_set_url: async (a, { drive, gate, sharePolicy }) => {
    const setUrlPath = validateRemotePath(a.path);
    const role = typeof a.role === "string" ? a.role : "viewer";
    if (!["viewer", "editor"].includes(role)) return fail("role must be viewer or editor");
    const password = typeof a.password === "string" && a.password ? validateFlagValue(a.password, "password") : undefined;
    const expiration = typeof a.expiration === "string" && a.expiration ? validateFlagValue(a.expiration, "expiration") : undefined;
    checkPublicLink(sharePolicy, { role, password, expiration }); // F-06
    await gate("drive_share_set_url", { ...a, password: password === undefined ? undefined : "[set]" });
    const link = await drive.shareSetUrl(setUrlPath, role as "viewer" | "editor", password, expiration);
    return ok(link);
  },
  drive_share_remove_url: async (a, { drive, gate }) => {
    const removeUrlPath = validateRemotePath(a.path);
    await gate("drive_share_remove_url", a);
    await drive.shareRemoveUrl(removeUrlPath);
    return ok({ message: `Public link removed: ${removeUrlPath}` });
  },
  drive_share_remove_all: async (a, { drive, gate }) => {
    const removeAllPath = validateRemotePath(a.path);
    await gate("drive_share_remove_all", a);
    const removeAll = await drive.shareRemoveAll(removeAllPath);
    const linkNote = removeAll.publicLink ? " A public link is still active — anyone with it keeps access; remove it with drive_share_remove_url." : "";
    return ok({ message: (removeAll.removed === 0 ? `Nothing to remove: ${removeAllPath} has no members or pending invitations.` : `Removed all members and invitations (${removeAll.removed}) from: ${removeAllPath}.`) + linkNote });
  },
};
