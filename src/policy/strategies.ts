// Conflict-strategy vocabularies, defined once so the MCP server and the companion CLI cannot drift.

export const UPLOAD_FILE_STRATEGIES = ["skip", "create-new-revision", "rename", "replace"] as const;
export const UPLOAD_FOLDER_STRATEGIES = ["skip", "merge", "rename", "replace"] as const;
export const DOWNLOAD_FILE_STRATEGIES = ["skip", "rename", "remove"] as const;
export const DOWNLOAD_FOLDER_STRATEGIES = ["skip", "merge", "rename", "remove"] as const;
export const PHOTO_UPLOAD_STRATEGIES = ["skip", "rename"] as const;
export const PHOTO_DOWNLOAD_STRATEGIES = ["skip", "rename", "remove"] as const;

export type UploadFileStrategy = (typeof UPLOAD_FILE_STRATEGIES)[number];
export type UploadFolderStrategy = (typeof UPLOAD_FOLDER_STRATEGIES)[number];
export type DownloadFileStrategy = (typeof DOWNLOAD_FILE_STRATEGIES)[number];
export type DownloadFolderStrategy = (typeof DOWNLOAD_FOLDER_STRATEGIES)[number];
export type PhotoUploadStrategy = (typeof PHOTO_UPLOAD_STRATEGIES)[number];
export type PhotoDownloadStrategy = (typeof PHOTO_DOWNLOAD_STRATEGIES)[number];

/** Human list: "skip, rename, or remove". */
export function humanList(values: readonly string[]): string {
  return values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

/**
 * Returns the strategy (default when `value` is undefined) or throws with a message naming `label` and the
 * allowed values. Anything that is not a string is rejected, never coerced.
 */
export function parseStrategy<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be ${humanList(allowed)}`);
  }
  return value as T;
}
