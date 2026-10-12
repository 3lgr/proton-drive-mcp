import { mkdtemp, readdir, readFile, lstat, rm } from "node:fs/promises";
import { readdirSync, lstatSync } from "node:fs";
import { registerTempDir, unregisterTempDir } from "../utils/tempDirs.js";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DriveService } from "./drive.js";
import { validateLocalPath } from "../utils/validation.js";
import { callContext } from "../utils/subprocess.js";
import { safeDownload, freezeDownload } from "./downloadGuard.js";
import { retryOnLocked } from "../utils/lockRetry.js";
import { showValue } from "../utils/text.js";

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 100_000;
const DEFAULT_READ_MAX_BYTES = 10 * 1024 * 1024;
const HARD_READ_MAX_BYTES = 50 * 1024 * 1024;

const TEXT_EXTS = new Set([
  "txt", "text", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "xml", "html", "htm", "log", "ini", "toml", "cfg", "conf", "env",
  "rst", "tex", "srt", "vtt", "sql", "sh", "bash", "zsh", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "java", "kt", "c", "h", "cpp",
  "hpp", "cs", "go", "rs", "rb", "php", "swift", "pl", "lua", "r", "ics", "vcf",
]);
const SUPPORTED = "plain text, markdown, json, csv/tsv, yaml, xml, html, log and common code files (UTF-8)";

export interface ReadContentArgs { path: string; maxChars?: number; offset?: number }
export interface ReadContentResult {
  path: string; format: string; size: number; chars: number; offset: number; text: string;
  truncated: boolean; nextOffset?: number; note?: string;
}
export type ReadContentDeps = Record<string, never>;

/** Download cap in bytes: PROTON_DRIVE_READ_MAX_BYTES, default 10 MB, never above 50 MB. */
export function readMaxBytes(): number {
  const n = Number(process.env["PROTON_DRIVE_READ_MAX_BYTES"]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HARD_READ_MAX_BYTES) : DEFAULT_READ_MAX_BYTES;
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function pickFormat(path: string, mediaType: string): "text" | undefined {
  const ext = extOf(path);
  if (TEXT_EXTS.has(ext)) return "text";
  if (/^text\//i.test(mediaType) || /^application\/(json|xml|x-yaml|yaml)$/i.test(mediaType)) return "text";
  return undefined;
}

function decodeUtf8(buf: Buffer): string {
  if (buf.includes(0)) throw new Error("not text: the file contains NUL bytes (binary)");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error("not text: the file is not valid UTF-8");
  }
}

/** Slices by code points (never splits a surrogate pair) and counts the total in one pass. */
export function sliceCodePoints(s: string, offset: number, max: number): { text: string; total: number; end: number } {
  let cp = 0, i = 0, startIdx = -1, endIdx = s.length, endCp = -1;
  while (i < s.length) {
    if (cp === offset) startIdx = i;
    if (cp === offset + max) { endIdx = i; endCp = cp; }
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    cp++;
  }
  if (cp === offset) startIdx = s.length;
  if (cp === offset + max) { endIdx = s.length; endCp = cp; }
  if (startIdx < 0) return { text: "", total: cp, end: cp }; // offset beyond the end
  return { text: s.slice(startIdx, endIdx), total: cp, end: endCp < 0 ? cp : endCp };
}

/**
 * Downloads into a private temp dir; the dir is always removed, also on abort or error. The size cap is enforced
 * WHILE downloading (the declared size is uploader-controlled): the directory is polled and the CLI is killed the
 * moment more than `cap` bytes are on disk, so a lying file can not fill the disk before the post-check.
 */
async function downloadBytes(drive: DriveService, path: string, cap: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "pdmcp-read-"));
  registerTempDir(dir);
  try {
    validateLocalPath(dir);
    const outer = callContext.getStore()?.signal;
    const controller = new AbortController();
    const relay = (): void => controller.abort();
    outer?.addEventListener("abort", relay, { once: true });
    let exceeded = false;
    let watched = dir;
    const watcher = setInterval(() => {
      try {
        let total = 0;
        for (const n of readdirSync(watched)) total += lstatSync(join(watched, n)).size;
        if (total > cap) { exceeded = true; controller.abort(); }
      } catch { /* the dir is being written to; look again next tick */ }
    }, 50);
    let r;
    try {
      r = await callContext.run({ signal: controller.signal }, () =>
        safeDownload(drive, freezeDownload({ remotePath: path, localPath: dir, fileStrategy: "rename", folderStrategy: "skip" }), { transient: true, onStaging: (s) => { watched = s; } }));
    } catch (e) {
      if (exceeded) throw new Error(`the download passed the read cap of ${cap} bytes and was stopped`);
      throw e;
    } finally {
      clearInterval(watcher);
      outer?.removeEventListener("abort", relay);
    }
    if (outer?.aborted) throw new Error("cancelled");
    if (r.failed > 0 || r.downloaded < 1) throw new Error("download failed");
    const names = await readdir(dir);
    if (names.length !== 1) throw new Error("unexpected download result");
    const file = join(dir, names[0]!);
    const st = await lstat(file); // lstat: a symlink is not a regular file
    if (!st.isFile()) throw new Error("unexpected download result");
    if (st.size > cap) throw new Error(`downloaded file is ${st.size} bytes, over the read cap of ${cap} bytes`);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
    unregisterTempDir(dir);
  }
}

export async function readDriveContent(drive: DriveService, args: ReadContentArgs, _deps: ReadContentDeps = {}): Promise<ReadContentResult> {
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const offset = args.offset ?? 0;
  const path = args.path;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_MAX_CHARS) throw new Error(`maxChars must be an integer from 1 to ${MAX_MAX_CHARS}`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  const node = ((await drive.info(path)) ?? {}) as Record<string, any>;
  const mediaType = typeof node.mediaType === "string" ? node.mediaType : "";
  if (node.type === "folder" || node.type === "album") throw new Error(`${showValue(path)} is a folder; drive_read_content reads files (use drive_list).`);
  if (/^application\/vnd\.proton\./i.test(mediaType)) {
    throw new Error(`${showValue(path)} is a Proton Docs/Sheets document; the CLI cannot download these, so its text cannot be read.`);
  }
  const format = pickFormat(path, mediaType);
  if (!format) throw new Error(`unsupported format for ${showValue(path)}${mediaType ? ` (${showValue(mediaType, 60, 20)})` : ""}. Supported: ${SUPPORTED}.`);
  const cap = readMaxBytes();
  // claimedSize is uploader-controlled: a lying claim only costs download bandwidth, since the
  // post-download lstat size check still applies to the real bytes.
  const declared = node.activeRevision?.claimedSize;
  if (typeof declared === "number" && declared > cap) {
    throw new Error(`${showValue(path)} is ${declared} bytes, over the read cap of ${cap} bytes (PROTON_DRIVE_READ_MAX_BYTES, max ${HARD_READ_MAX_BYTES}). Use drive_download.`);
  }

  const buf = await retryOnLocked(() => downloadBytes(drive, path, cap));
  let text = decodeUtf8(buf);
  text = text.replaceAll("\0", "");

  const s = sliceCodePoints(text, offset, maxChars);
  const truncated = s.end < s.total;
  return {
    path, format, size: buf.length, chars: s.total, offset, text: s.text, truncated,
    ...(truncated ? { nextOffset: s.end } : {}),
  };
}
