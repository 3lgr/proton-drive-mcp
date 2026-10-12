// Handlers: Photos and albums.
import { validateRemotePath, validateLocalPath, validateName } from "../../utils/validation.js";
import { GATES } from "../../policy/gates.js";
import { approvalField } from "../../policy/untrusted.js";
import { albumShare, sharedDestinationNote } from "../../policy/sharedDestination.js";
import { precheckUpload, withUploadSnapshot } from "../../services/uploadSnapshot.js";
import { freezePhotoDownload, precheckPhotoDownload, safePhotoDownload, describePhotoDownload } from "../../services/downloadGuard.js";
import { PHOTO_UPLOAD_STRATEGIES, PHOTO_DOWNLOAD_STRATEGIES, parseStrategy } from "../../policy/strategies.js";
import type { Handler } from "../context.js";
import { ok, fail, paginate, photoOrder } from "../result.js";
import { PAGE_DEFAULTS } from "../catalog.js";

export const photosHandlers: Record<string, Handler> = {
  photos_list_albums: async (_a, { drive }) => {
    return ok(await drive.listAlbums());
  },
  photos_create_album: async (a, { drive }) => {
    if (typeof a.name !== "string" || !a.name.trim()) return fail("name must be a non-empty string");
    const albumName = validateName(a.name);
    await drive.createAlbum(albumName);
    return ok({ message: `Album created: ${albumName}` });
  },
  photos_update_album: async (a, { drive }) => {
    const updateAlbumPath = validateRemotePath(a.albumPath);
    if (!updateAlbumPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
    const newName = typeof a.name === "string" && a.name.trim() ? validateName(a.name) : undefined;
    const coverPhotoUid = typeof a.coverPhotoUid === "string" && a.coverPhotoUid.trim() ? validateName(a.coverPhotoUid) : undefined;
    if (!newName && !coverPhotoUid) return fail("At least one of name or coverPhotoUid must be provided");
    await drive.updateAlbum(updateAlbumPath, newName, coverPhotoUid);
    return ok({ message: `Album updated: ${newName ? `/albums/${newName}` : updateAlbumPath}` });
  },
  photos_delete_album: async (a, { drive }) => {
    const albumDelPath = a.albumPath as string;
    await drive.deleteAlbum(albumDelPath, a.force === true, a.save === true);
    return ok({ message: `Album deleted: ${albumDelPath}` });
  },
  photos_list_album_photos: async (a, { drive }) => {
    const albumListPath = validateRemotePath(a.albumPath);
    if (!albumListPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
    return ok(paginate((await drive.listAlbumPhotos(albumListPath, a.loadDetails === true)).sort(photoOrder), a, PAGE_DEFAULTS.photos_list_album_photos));
  },
  photos_add_to_album: async (a, { drive, gate, sharePolicy }) => {
    const addAlbumPath = validateRemotePath(a.albumPath);
    const addPhotoPath = validateRemotePath(a.photoPath);
    if (!addAlbumPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
    if (!addPhotoPath.startsWith("/photos/")) return fail("photoPath must start with /photos/");
    const share = await albumShare(drive, sharePolicy, addAlbumPath);
    await gate("photos_add_to_album", { ...a, sharedDestination: share.shared },
      `photos_add_to_album needs your approval. It ${GATES.photos_add_to_album!.consequence}\nalbumPath: ${approvalField(addAlbumPath)}\nphotoPath: ${approvalField(addPhotoPath)}${sharedDestinationNote(share)}`);
    await drive.addPhotoToAlbum(addAlbumPath, addPhotoPath);
    return ok({ message: `Added ${addPhotoPath} to ${addAlbumPath}` });
  },
  photos_remove_from_album: async (a, { drive }) => {
    await drive.removePhotoFromAlbum(a.albumPath as string, a.photoPath as string);
    return ok({ message: `Removed ${a.photoPath as string} from ${a.albumPath as string}` });
  },
  photos_list_timeline: async (a, { drive }) => {
    return ok(paginate((await drive.photoTimeline(a.loadDetails === true)).sort(photoOrder), a, PAGE_DEFAULTS.photos_list_timeline));
  },
  photos_download: async (a, { drive, gate }) => {
    if (!Array.isArray(a.photoPaths) || a.photoPaths.length === 0) return fail("photoPaths must be a non-empty array of strings");
    const downloadPaths = a.photoPaths.map((p) => validateRemotePath(p));
    const downloadFolder = validateLocalPath(a.localFolder);
    const pdcs = parseStrategy(a.conflictStrategy, PHOTO_DOWNLOAD_STRATEGIES, "conflictStrategy", "skip");
    const photoReq = freezePhotoDownload({ remotePaths: downloadPaths, localPath: downloadFolder, strategy: pdcs });
    precheckPhotoDownload(photoReq);
    await gate("photos_download", { confirmed: a.confirmed, conflictStrategy: photoReq.strategy },
      `photos_download needs your approval. It ${GATES.photos_download!.consequence}\n${describePhotoDownload(photoReq)}`);
    const downloadSummary = await safePhotoDownload(drive, photoReq);
    if (downloadSummary.failedItems > 0) {
      return fail(`Download completed with ${downloadSummary.failedItems} failed item(s). transferred=${downloadSummary.transferredItems}`);
    }
    return ok(downloadSummary);
  },
  photos_upload: async (a, { drive }) => {
    if (!Array.isArray(a.localPaths) || a.localPaths.length === 0) return fail("localPaths must be a non-empty array of strings");
    const uploadPaths = a.localPaths.map((p) => validateLocalPath(p, { scan: true }));
    const approvedPhotos = uploadPaths.map((p) => precheckUpload(p));
    const pucs = parseStrategy(a.conflictStrategy, PHOTO_UPLOAD_STRATEGIES, "conflictStrategy", "skip");
    const uploadSummary = await withUploadSnapshot(uploadPaths, (snaps) => drive.photoUpload(snaps, pucs), { approved: approvedPhotos });
    if (uploadSummary.failedItems > 0) {
      return fail(`Upload completed with ${uploadSummary.failedItems} failed item(s). transferred=${uploadSummary.transferredItems}`);
    }
    return ok(uploadSummary);
  },
};
