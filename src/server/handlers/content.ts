// Handlers: File content and sync-folder tools.
import { envFlag, SYNC_WRITE_ENV } from "../../utils/envFlag.js";
import { validateRemotePath } from "../../utils/validation.js";
import { getSyncRoot, readSyncFile, writeSyncFile, syncFileExists, precheckSyncWrite } from "../../utils/syncfs.js";
import { readDriveContent } from "../../services/content.js";
import { GATES } from "../../policy/gates.js";
import { approvalField } from "../../policy/untrusted.js";
import { assertMutablePath } from "../../policy/remoteRoots.js";
import { destinationShare, sharedDestinationNote } from "../../policy/sharedDestination.js";
import { splitRemotePath } from "../../services/driveShape.js";
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
  drive_write_file: async (a, { drive, gate, assertConsent, sharePolicy }) => {
    // N-02: fail closed. The operator must opt in; the sync folder is trusted by other programs.
    if (!envFlag(SYNC_WRITE_ENV)) return fail(`drive_write_file is disabled. The operator can enable it with ${SYNC_WRITE_ENV}=1 (accepting that the model can write plain data files into the sync folder).`);
    const syncRoot = getSyncRoot();
    if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
    if (typeof a.content !== "string") return fail("content must be a string");
    const writePath = validateRemotePath(a.path);
    assertMutablePath(writePath, "write");
    precheckSyncWrite(syncRoot, writePath); // N-02: a forbidden target is refused before any prompt
    // the gate is always evaluated; it only asks when the write would replace an existing file
    const overwrite = await syncFileExists(syncRoot, writePath);
    // N-01: the sync folder is uploaded as it is; a file created inside a shared folder (or below one) is seen by its members
    const share = await destinationShare(drive, sharePolicy, splitRemotePath(writePath).parent);
    await gate("drive_write_file", { ...a, overwrite, sharedDestination: share.shared },
      `drive_write_file needs your approval. It ${GATES.drive_write_file!.consequence}\nTarget: ${approvalField(writePath)}${sharedDestinationNote(share)}`);
    assertConsent();
    await writeSyncFile(syncRoot, writePath, a.content);
    return ok({ message: `Written: ${writePath}` });
  },
};
