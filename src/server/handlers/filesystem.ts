// Handlers: Auth, filesystem, trash, copy, bulk and sync-plan tools.
import { NeedsConfirmationError } from "../../utils/errors.js";
import { validateRemotePath, validateRemotePathList, validateLocalPath, validateName, validateFlagValue } from "../../utils/validation.js";
import { driveSearch, driveTree } from "../../services/find.js";
import { syncPlan, planBulkMove, planBulkTrash, loadListing, foldersToList, type Direction, type Compare } from "../../services/plan.js";
import { invalidatePath } from "../../services/walk.js";
import { GATES } from "../../policy/gates.js";
import { approvalField } from "../../policy/untrusted.js";
import { precheckUpload, withUploadSnapshot } from "../../services/uploadSnapshot.js";
import { freezeDownload, precheckDownload, safeDownload, describeDownload } from "../../services/downloadGuard.js";
import { UPLOAD_FILE_STRATEGIES, UPLOAD_FOLDER_STRATEGIES, DOWNLOAD_FILE_STRATEGIES, DOWNLOAD_FOLDER_STRATEGIES, parseStrategy } from "../../policy/strategies.js";
import type { Handler } from "../context.js";
import { splitRemotePath } from "../../services/drive.js";
import type { DriveService } from "../../services/drive.js";
import type { SharePolicy } from "../../policy/sharePolicy.js";
import { isRootPath } from "../../policy/remoteRoots.js";
import { ok, fail, paginate, byTimeDescThenId } from "../result.js";
import { bulkPrompt } from "../approvalText.js";
import { PAGE_DEFAULTS } from "../catalog.js";

/**
 * True when `folder` is already shared (members, invitations or a public link) and the share policy is strict.
 * Lookup failures count as "not known to be shared": the callers still validate paths and roots first.
 */
async function folderIsShared(drive: DriveService, policy: SharePolicy, folder: string): Promise<boolean> {
  if (policy.mode === "off" || isRootPath(folder)) return false;
  try { return (await drive.shareStatus(folder)).isShared; } catch { return false; }
}

export const filesystemHandlers: Record<string, Handler> = {
  drive_auth_status: async (_a, { drive }) => {
    return ok(await drive.authStatus());
  },
  drive_auth_logout: async (_a, { drive }) => {
    await drive.authLogout();
    return ok({ message: "Logged out successfully." });
  },
  drive_version: async (_a, { drive }) => {
    return ok(await drive.version());
  },
  drive_list: async (a, { drive }) => {
    const listPath = validateRemotePath(a.path);
    const listType = a.type === "file" || a.type === "folder" ? a.type : undefined;
    return ok({ path: listPath, ...paginate(await drive.list(listPath, { type: listType }), a, PAGE_DEFAULTS.drive_list) });
  },
  drive_info: async (a, { drive }) => {
    return ok(await drive.info(validateRemotePath(a.path), a.verbose === true));
  },
  drive_tree: async (a, { drive }) => {
    return ok(await driveTree(drive, a));
  },
  drive_search: async (a, { drive }) => {
    return ok(await driveSearch(drive, a));
  },
  drive_upload: async (a, { drive, gate }) => {
    const fcs = parseStrategy(a.fileConflictStrategy, UPLOAD_FILE_STRATEGIES, "fileConflictStrategy", "skip");
    const dcs2 = parseStrategy(a.folderConflictStrategy, UPLOAD_FOLDER_STRATEGIES, "folderConflictStrategy", "skip");
    const uploadLocal = validateLocalPath(a.localPath, { scan: true });
    const approvedUpload = precheckUpload(uploadLocal); // F-04: refuse secrets/links/special files before a human is asked
    const uploadRemote = validateRemotePath(a.remotePath);
    // The CLI uploads a private, frozen snapshot of the validated tree, never the original path. The gate (when
    // it applies) approves the snapshot's own manifest; the snapshot is re-hashed after the answer.
    const uploadResult = await withUploadSnapshot(
      [uploadLocal],
      ([snap]) => drive.upload(snap as string, uploadRemote, fcs, dcs2, a.skipThumbnails === true),
      {
        approved: [approvedUpload],
        approve: (m) => gate("drive_upload", { ...a, fileConflictStrategy: fcs, folderConflictStrategy: dcs2 },
          `drive_upload needs your approval. It ${GATES.drive_upload!.consequence}\n` +
          `Sending ${m.files} file(s), ${m.bytes} bytes from ${approvalField(uploadLocal)} to ${approvalField(uploadRemote)} (content digest ${m.digest.slice(0, 16)})\n` +
          `fileConflictStrategy: ${fcs}\nfolderConflictStrategy: ${dcs2}`),
      },
    );
    if (uploadResult.failed > 0) {
      return fail(`Upload completed with ${uploadResult.failed} failed file(s). uploaded=${uploadResult.uploaded} skipped=${uploadResult.skipped}`);
    }
    return ok(uploadResult);
  },
  drive_download: async (a, { drive, gate }) => {
    const fdcs = parseStrategy(a.fileConflictStrategy, DOWNLOAD_FILE_STRATEGIES, "fileConflictStrategy", "skip");
    const fodcs = parseStrategy(a.folderConflictStrategy, DOWNLOAD_FOLDER_STRATEGIES, "folderConflictStrategy", "skip");
    const downloadRemote = validateRemotePath(a.remotePath);
    const downloadLocal = validateLocalPath(a.localPath);
    // F-02: one frozen request is validated, shown to the human and executed (never re-read from `a`).
    const dlReq = freezeDownload({ remotePath: downloadRemote, localPath: downloadLocal, fileStrategy: fdcs, folderStrategy: fodcs });
    precheckDownload(dlReq.remotePath, dlReq.localPath);
    await gate("drive_download", { confirmed: a.confirmed, fileConflictStrategy: dlReq.fileStrategy, folderConflictStrategy: dlReq.folderStrategy },
      `drive_download needs your approval. It ${GATES.drive_download!.consequence}\n${describeDownload(dlReq)}`);
    const downloadResult = await safeDownload(drive, dlReq);
    if (downloadResult.failed > 0) {
      return fail(`Download completed with ${downloadResult.failed} failed file(s). downloaded=${downloadResult.downloaded} skipped=${downloadResult.skipped}`);
    }
    return ok(downloadResult);
  },
  drive_mkdir: async (a, { drive }) => {
    const mkdirPath = validateRemotePath(a.path);
    await drive.mkdir(mkdirPath);
    return ok({ message: `Folder created: ${mkdirPath}` });
  },
  drive_rename: async (a, { drive }) => {
    const renamePath = validateRemotePath(a.path);
    const newName = validateName(a.newName);
    await drive.rename(renamePath, newName);
    return ok({ message: `Renamed: ${renamePath} → ${newName}` });
  },
  drive_move: async (a, { drive, gate, sharePolicy }) => {
    const moveSrc = validateRemotePath(a.sourcePath);
    const moveDst = validateRemotePath(a.destinationPath);
    const dstParent = splitRemotePath(moveDst).parent;
    const shared = dstParent !== splitRemotePath(moveSrc).parent && (await folderIsShared(drive, sharePolicy, dstParent));
    await gate("drive_move", { ...a, sharedDestination: shared },
      `drive_move needs your approval. It ${GATES.drive_move!.consequence}\nsourcePath: ${approvalField(moveSrc)}\ndestinationPath: ${approvalField(moveDst)}`);
    await drive.move(moveSrc, moveDst);
    return ok({ message: `Moved: ${moveSrc} → ${moveDst}` });
  },
  drive_delete: async (a, { drive }) => {
    const deletePath = a.path as string | undefined;
    const deleteUid = a.uid as string | undefined;
    await drive.delete(deletePath, deleteUid);
    return ok({ message: `Deleted: ${deletePath ?? `uid ${deleteUid}`}` });
  },
  drive_list_trash: async (a, { drive }) => {
    const trashed = await drive.listTrash();
    trashed.sort(byTimeDescThenId((f) => f.trashedAt, (f) => f.uid));
    return ok(paginate(trashed, a, PAGE_DEFAULTS.drive_list_trash));
  },
  drive_trash: async (a, { drive }) => {
    const trashPath = validateRemotePath(a.path);
    await drive.trash(trashPath);
    return ok({ message: `Moved to trash: ${trashPath}` });
  },
  drive_restore: async (a, { drive }) => {
    const restorePath = a.path === undefined ? undefined : validateRemotePath(a.path);
    const restoreUid = a.uid ? validateFlagValue(a.uid as string, "uid") : undefined;
    await drive.restore(restorePath, restoreUid);
    return ok({ message: `Restored from trash: ${restorePath ?? `uid ${restoreUid}`}` });
  },
  drive_empty_trash: async (_a, { drive }) => {
    await drive.emptyTrash();
    return ok({ message: "Trash emptied." });
  },
  drive_copy: async (a, { drive, gate, sharePolicy }) => {
    const copySrc = validateRemotePath(a.sourcePath);
    const copyDst = validateRemotePath(a.destinationPath);
    const copyName = typeof a.newName === "string" ? validateName(a.newName) : undefined;
    await gate("drive_copy", { ...a, sharedDestination: await folderIsShared(drive, sharePolicy, copyDst) },
      `drive_copy needs your approval. It ${GATES.drive_copy!.consequence}\nsourcePath: ${approvalField(copySrc)}\ndestinationPath: ${approvalField(copyDst)}`);
    await drive.copy(copySrc, copyDst, copyName);
    return ok({ message: `Copied: ${copySrc} → ${copyDst}${copyName ? ` as '${copyName}'` : ""}` });
  },
  drive_sync_plan: async (a, { drive }) => {
    const direction = a.direction === undefined ? undefined : String(a.direction);
    if (direction !== undefined && !["up", "down", "both"].includes(direction)) return fail("direction must be up, down or both");
    const compare = a.compare === undefined ? undefined : String(a.compare);
    if (compare !== undefined && !["size-mtime", "sha1"].includes(compare)) return fail("compare must be size-mtime or sha1");
    if (a.ignore !== undefined && (!Array.isArray(a.ignore) || a.ignore.some((g) => typeof g !== "string"))) return fail("ignore must be an array of strings");
    return ok(await syncPlan(drive, {
      localPath: a.localPath as string, drivePath: a.drivePath as string,
      direction: direction as Direction | undefined, compare: compare as Compare | undefined,
      ignore: a.ignore as string[] | undefined, limit: typeof a.limit === "number" ? a.limit : undefined,
    }));
  },
  drive_bulk_move: async (a, { drive, gate, sharePolicy }) => {
    const sources = validateRemotePathList(a.sources, "sources");
    const destFolder = validateRemotePath(a.destinationFolder);
    const movePlan = planBulkMove(sources, destFolder, await loadListing(drive, foldersToList(sources, destFolder)));
    if (a.confirmed !== true) {
      return ok({ applied: false, ...movePlan, next: movePlan.problems.length ? "Fix problems first." : "Get user approval, then confirmed=true." });
    }
    if (movePlan.problems.length) return fail(`drive_bulk_move not applied, nothing moved: ${JSON.stringify(movePlan.problems)}`);
    const sharedNote = (await folderIsShared(drive, sharePolicy, destFolder)) ? "\nWARNING: the destination folder is already shared with other people; they will see these items." : "";
    try { await gate("drive_bulk_move", a, bulkPrompt("drive_bulk_move", "Move", sources, destFolder) + sharedNote); }
    catch (e) { if (e instanceof NeedsConfirmationError) return fail(`drive_bulk_move not applied, nothing moved: ${e.message}`); throw e; }
    try { await drive.bulkMove(sources, destFolder); } finally { invalidatePath(destFolder); sources.forEach(invalidatePath); }
    return ok({ applied: true, moved: movePlan.plan.length, plan: movePlan.plan });
  },
  drive_bulk_trash: async (a, { drive, gate }) => {
    const trashPaths = validateRemotePathList(a.paths, "paths");
    const trashPlan = planBulkTrash(trashPaths, await loadListing(drive, foldersToList(trashPaths)));
    if (a.confirmed !== true) {
      return ok({ applied: false, ...trashPlan, next: trashPlan.problems.length ? "Fix problems first." : "Get user approval, then confirmed=true." });
    }
    if (trashPlan.problems.length) return fail(`drive_bulk_trash not applied, nothing trashed: ${JSON.stringify(trashPlan.problems)}`);
    try { await gate("drive_bulk_trash", a, bulkPrompt("drive_bulk_trash", "Trash", trashPaths)); }
    catch (e) { if (e instanceof NeedsConfirmationError) return fail(`drive_bulk_trash not applied, nothing trashed: ${e.message}`); throw e; }
    try { await drive.bulkTrash(trashPaths); } finally { trashPaths.forEach(invalidatePath); }
    return ok({ applied: true, trashed: trashPlan.plan.length, plan: trashPlan.plan });
  },
};
