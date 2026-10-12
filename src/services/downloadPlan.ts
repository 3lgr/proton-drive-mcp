// Pure planning for a download promotion. No filesystem access: it receives what was staged and what already
// exists locally (as plain data) and returns the EXACT list of actions that may run. The executor performs only
// those actions and never re-derives anything from a name.
//
// Rules (fail closed: anything not explicitly allowed throws and nothing is promoted):
//   - an absent target is simply placed;
//   - an existing symlink, FIFO, socket or device at a target always refuses;
//   - skip   : the existing item is left untouched;
//   - rename : the new item gets a free name, nothing existing is touched;
//   - merge  : directory onto directory only, children are planned one by one, existing files are never overwritten;
//   - remove : same type only. A file replaces a regular file; a directory replaces an EMPTY directory.
//              A non-empty local directory is never deleted, and a type mismatch refuses.
import { showValue } from "../utils/text.js";

const CONTROL_RE = new RegExp("[\\x00-\\x1f\\x7f\\u2028\\u2029]");
// Bidi overrides/isolates, zero-width and BOM characters: names that look like something else.
const SPOOF_RE = new RegExp("[\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]");

export interface EntryNameOptions { top?: boolean }

/** Throws unless `name` is one plain path component. `top` additionally refuses leading-dot names. */
export function assertSafeEntryName(name: string, opts: EntryNameOptions = {}): void {
  if (name === "") throw new Error("unsafe entry name: empty name");
  if (name === "." || name === "..") throw new Error(`unsafe entry name: ${showValue(name)}`);
  if (name.includes("/") || name.includes("\\")) throw new Error(`unsafe entry name (contains a path separator): ${showValue(name)}`);
  if (CONTROL_RE.test(name)) throw new Error(`unsafe entry name (control characters): ${showValue(name)}`);
  if (SPOOF_RE.test(name)) throw new Error(`unsafe entry name (invisible or direction-control characters): ${showValue(name)}`);
  if (opts.top && name.startsWith(".")) {
    throw new Error(`refusing to download an item whose name starts with '.': ${showValue(name)}. Dotfiles and dot-folders can configure the local machine (shell, ssh, git); rename the item in Drive first.`);
  }
}

export type Kind = "file" | "dir" | "symlink" | "other";
export interface StagedNode { readonly name: string; readonly kind: Kind; readonly children: readonly StagedNode[]; readonly files: number }
export interface Existing { readonly kind: Kind; readonly empty?: boolean }
export type Lookup = (relPath: string) => Existing | undefined;
export interface Policy {
  readonly file: "skip" | "rename" | "remove";
  readonly folder: "skip" | "merge" | "rename" | "remove";
}
export type Action =
  | { readonly op: "place"; readonly srcRel: string; readonly dstRel: string; readonly kind: "file" | "dir" }
  | { readonly op: "skip"; readonly srcRel: string; readonly files: number }
  | { readonly op: "unlink"; readonly dstRel: string }
  | { readonly op: "rmdir"; readonly dstRel: string };

const join = (parent: string, name: string): string => (parent === "" ? name : `${parent}/${name}`);

function freeName(parentRel: string, name: string, lookup: Lookup): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (lookup(join(parentRel, candidate)) === undefined) return candidate;
  }
  throw new Error("could not find a free name for the downloaded item");
}

const foldKey = (n: string): string => n.normalize("NFC").toLowerCase();

/** Every node below (and including) `node` must be a plain file or folder with a safe, non-colliding name. */
function assertTreeAcceptable(node: StagedNode, top: boolean): asserts node is StagedNode & { kind: "file" | "dir" } {
  if (node.kind !== "file" && node.kind !== "dir") throw new Error(`download refused: ${showValue(node.name)} is a ${node.kind}, not a regular file or folder`);
  assertSafeEntryName(node.name, { top });
  const seen = new Set<string>();
  for (const c of node.children) {
    const k = foldKey(c.name);
    if (seen.has(k)) throw new Error(`download refused: names that differ only by case or Unicode form collide: ${showValue(c.name)}`);
    seen.add(k);
    assertTreeAcceptable(c, false);
  }
}

function planNode(node: StagedNode, srcParent: string, dstParent: string, top: boolean, policy: Policy, lookup: Lookup, out: Action[]): void {
  assertTreeAcceptable(node, top);
  const srcRel = join(srcParent, node.name);
  const dstRel = join(dstParent, node.name);
  const ex = lookup(dstRel);
  if (ex === undefined) { out.push({ op: "place", srcRel, dstRel, kind: node.kind }); return; }
  if (ex.kind !== "file" && ex.kind !== "dir") throw new Error(`download refused: ${showValue(dstRel)} exists locally as a ${ex.kind}`);

  const strategy = node.kind === "dir" ? policy.folder : policy.file;
  switch (strategy) {
    case "skip":
      out.push({ op: "skip", srcRel, files: node.files });
      return;
    case "rename": {
      const name = freeName(dstParent, node.name, lookup);
      out.push({ op: "place", srcRel, dstRel: join(dstParent, name), kind: node.kind });
      return;
    }
    case "merge":
      if (node.kind !== "dir" || ex.kind !== "dir") throw new Error(`download refused: merge only combines a folder with a folder (${showValue(dstRel)})`);
      for (const child of node.children) planNode(child, srcRel, dstRel, false, policy, lookup, out);
      return;
    case "remove":
      if (policy.folder === "merge" && dstParent !== "" && !top) throw new Error(`download refused: merge never overwrites existing files (${showValue(dstRel)}); use rename or skip`);
      if (node.kind !== ex.kind) throw new Error(`download refused: ${showValue(dstRel)} is a ${ex.kind} locally but a ${node.kind} remotely`);
      if (node.kind === "file") {
        out.push({ op: "unlink", dstRel }, { op: "place", srcRel, dstRel, kind: "file" });
        return;
      }
      if (ex.empty !== true) throw new Error(`download refused: ${showValue(dstRel)} is a non-empty local folder and is never deleted; use merge or rename`);
      out.push({ op: "rmdir", dstRel }, { op: "place", srcRel, dstRel, kind: "dir" });
      return;
    default:
      throw new Error(`unknown conflict strategy ${showValue(String(strategy))}`);
  }
}

/** The exact, ordered actions that may run. Throws (and so promotes nothing) on the first violation. */
export function planDownload(top: readonly StagedNode[], lookup: Lookup, policy: Policy): Action[] {
  const out: Action[] = [];
  const seen = new Set<string>();
  for (const node of top) {
    const key = node.name.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error(`download refused: names that differ only by case or Unicode form collide: ${showValue(node.name)}`);
    seen.add(key);
    planNode(node, "", "", true, policy, lookup, out);
  }
  return out;
}
