// Handlers: File content and sync-folder tools.
import { validateRemotePath } from "../../utils/validation.js";
import { getSyncRoot, readSyncFile } from "../../utils/syncfs.js";
import { readDriveContent } from "../../services/content.js";
import type { Handler } from "../context.js";
import { ok, fail } from "../result.js";

export const contentHandlers: Record<string, Handler> = {
  drive_read_content: async (a, { drive }) => {
    return ok(await readDriveContent(drive, { path: validateRemotePath(a.path), maxChars: a.maxChars as number | undefined, offset: a.offset as number | undefined }));
  },
  drive_read_file: async (a) => {
    const syncRoot = getSyncRoot();
    if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
    const readPath = validateRemotePath(a.path);
    const content = await readSyncFile(syncRoot, readPath);
    return ok({ path: readPath, content });
  },
};
