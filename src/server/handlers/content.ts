// Handlers: File content and sync-folder tools.
import { validateRemotePath } from "../../utils/validation.js";
import { getSyncRoot, readSyncFile, writeSyncFile, syncFileExists } from "../../utils/syncfs.js";
import { readDriveContent } from "../../services/content.js";
import { GATES } from "../../policy/gates.js";
import { approvalField } from "../../policy/untrusted.js";
import { assertMutablePath } from "../../policy/remoteRoots.js";
import type { Handler } from "../context.js";
import { ok, fail } from "../result.js";
import { anyLocalPathAllowed, assertSyncRootUsable } from "../../utils/localguard.js";

export const contentHandlers: Record<string, Handler> = {
  drive_read_content: async (a, { drive }) => {
    return ok(await readDriveContent(drive, { path: validateRemotePath(a.path), maxChars: a.maxChars as number | undefined, offset: a.offset as number | undefined }));
  },
  drive_read_file: async (a) => {
    const syncRoot = getSyncRoot();
    if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
    if (!anyLocalPathAllowed()) assertSyncRootUsable(syncRoot); // same root rules as every other local path
    const readPath = validateRemotePath(a.path);
    const content = await readSyncFile(syncRoot, readPath);
    return ok({ path: readPath, content });
  },
  drive_write_file: async (a, { gate }) => {
    const syncRoot = getSyncRoot();
    if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
    if (!anyLocalPathAllowed()) assertSyncRootUsable(syncRoot);
    if (typeof a.content !== "string") return fail("content must be a string");
    const writePath = validateRemotePath(a.path);
    assertMutablePath(writePath, "write");
    if (await syncFileExists(syncRoot, writePath)) {
      await gate("drive_write_file", a, `drive_write_file needs your approval. It ${GATES.drive_write_file!.consequence}\nTarget: ${approvalField(writePath)}`);
    }
    await writeSyncFile(syncRoot, writePath, a.content);
    return ok({ message: `Written: ${writePath}` });
  },
};
