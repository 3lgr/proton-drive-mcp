import { FILESYSTEM_TOOLS } from "./filesystem.js";
import { SHARING_TOOLS } from "./sharing.js";
import { PHOTOS_TOOLS } from "./photos.js";

const ORDER: readonly string[] = ["drive_auth_status", "drive_auth_logout", "drive_version", "drive_list", "drive_info", "drive_tree", "drive_search", "drive_upload", "drive_download", "drive_mkdir", "drive_rename", "drive_move", "drive_delete", "drive_share_status", "drive_list_trash", "drive_share_invite", "drive_share_revoke", "drive_trash", "drive_restore", "drive_empty_trash", "drive_copy", "drive_list_invitations", "drive_invitation_accept", "drive_invitation_reject", "drive_share_leave", "drive_share_set_url", "drive_share_remove_url", "drive_share_remove_all", "photos_list_albums", "photos_create_album", "photos_update_album", "photos_delete_album", "photos_list_album_photos", "photos_add_to_album", "photos_remove_from_album", "photos_list_timeline", "photos_download", "photos_upload", "drive_read_content", "drive_read_file", "drive_sync_plan", "drive_bulk_move", "drive_bulk_trash", "drive_usage", "drive_find_duplicates", "drive_sharing_audit"];
const all = [...FILESYSTEM_TOOLS, ...SHARING_TOOLS, ...PHOTOS_TOOLS];

/** Every tool definition, in the order the server has always advertised them. */
export const TOOLS = [...all].sort((x, y) => ORDER.indexOf(x.name) - ORDER.indexOf(y.name));
