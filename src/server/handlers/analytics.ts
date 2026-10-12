// Handlers: Read-only analytics.
import { validateRemotePath } from "../../utils/validation.js";
import { driveUsage, driveFindDuplicates, driveSharingAudit } from "../../services/analytics.js";
import type { Handler } from "../context.js";
import { ok } from "../result.js";

export const analyticsHandlers: Record<string, Handler> = {
  drive_usage: async (a, { drive }) => {
    return ok(await driveUsage(drive, {
      path: a.path === undefined ? "/my-files" : validateRemotePath(a.path),
      top: a.top as number | undefined,
      olderThanDays: a.olderThanDays as number | undefined,
      refresh: a.refresh === true,
    }));
  },
  drive_find_duplicates: async (a, { drive }) => {
    return ok(await driveFindDuplicates(drive, {
      path: a.path === undefined ? "/my-files" : validateRemotePath(a.path),
      minSize: a.minSize as number | undefined,
      verify: a.verify === true,
      maxVerifyBytes: a.maxVerifyBytes as number | undefined,
      maxVerifyTotalBytes: a.maxVerifyTotalBytes as number | undefined,
      limit: a.limit as number | undefined,
      refresh: a.refresh === true,
    }));
  },
  drive_sharing_audit: async (a, { drive }) => {
    return ok(await driveSharingAudit(drive, {
      path: a.path === undefined ? "/my-files" : validateRemotePath(a.path),
      refresh: a.refresh === true,
    }));
  },
};
