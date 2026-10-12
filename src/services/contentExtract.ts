// Text extraction for .docx and .pdf. Runs inside the sandboxed parser process (contentChild); kept free of
// project imports so that process starts light. DOCUMENT EXTRACTION IS OFF BY DEFAULT (content.ts requires
// PROTON_DRIVE_ENABLE_DOC_EXTRACT=1): complex formats keep producing parser differentials, so the operator opts in
// knowingly. Plain text is not affected.
//
// WHAT IS EXTRACTED (docx): the visible text of the document BODY, word/document.xml only, one line per paragraph
// (w:t text, tabs, breaks). In doubt a run is DROPPED and counted (`hiddenTextDropped`): runs with w:vanish /
// w:specVanish / w:webHidden, white or background-coloured text, font size <= 1 pt, runs and paragraphs whose style
// (word/styles.xml, with basedOn and docDefaults) is hidden, tracked deletions/moves (w:del, w:moveFrom) and the whole
// of mc:AlternateContent (text boxes included: the choice/fallback pair is a classic way to show a reader one thing
// and a parser another). NOT extracted: headers, footers, footnotes/endnotes, comments, field codes, document
// properties, embedded objects and every other part of the package. What a person sees in Word can therefore include
// more than the model receives; the model never receives text that Word would hide.
// PDF: the text layer as the PDF library returns it. A PDF can carry invisible text (white, tiny, render mode 3);
// that can not be told apart from visible text here, which is one more reason the result is delivered as untrusted.
//
// ZIP: the central directory is the only authority. Local headers must agree with it (name, method, sizes), entries
// must not overlap and must tile the file with no unaccounted bytes between them (smuggled data), names must be
// unique (case-folded) and safe.

export const DOCX_MAX_UNCOMPRESSED = 20 * 1024 * 1024;
export const DOCX_MAX_STYLES = 2 * 1024 * 1024;
/** Archive entries a .docx may declare (a real document has a few dozen). */
export const ZIP_MAX_ENTRIES = 5_000;
/** word/document.xml may not expand more than this factor (deflate tops out near 1000:1; text sits at 5-20:1). */
export const ZIP_MAX_RATIO = 100;
export const PDF_MAX_PAGES = 100;

export interface ExtractResult { text: string; note?: string; capped: boolean; hiddenTextDropped?: number }
export type Loader = (name: string) => Promise<any>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
  });
}

// ---- visibility model ---------------------------------------------------------------------------------------

const TEXT_PIECE = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\b[^<>]*\/?>/g;
const FLAG_PROP = /<w:(vanish|specVanish|webHidden)(?:\s+w:val="([^"]*)")?\s*\/?>/g;
const OFF = new Set(["0", "false", "off"]);

/** True when run/style properties make the text invisible, or when we can not tell (white, background, <= 1 pt). */
export function hiddenProps(props: string): boolean {
  for (const m of props.matchAll(FLAG_PROP)) if (!OFF.has((m[2] ?? "").toLowerCase())) return true;
  const color = /<w:color\b[^<>]*>/.exec(props)?.[0] ?? "";
  if (/w:val="(?:FFFFFF|FFF)"/i.test(color) || /w:themeColor="(?:background1|bg1|background2|bg2)"/i.test(color)) return true;
  const fill = /<w:shd\b[^<>]*w:fill="([0-9A-Fa-f]{6})"/.exec(props)?.[1];
  const val = /<w:color\b[^<>]*w:val="([0-9A-Fa-f]{6})"/.exec(props)?.[1];
  if (fill && val && fill.toLowerCase() === val.toLowerCase()) return true;
  for (const m of props.matchAll(/<w:sz(?:Cs)?\s+w:val="(\d+)"/g)) if (Number(m[1]) <= 2) return true;
  return false;
}

interface StyleInfo { hidden: Set<string>; defaultHidden: boolean }

/** Which styles hide text: their own properties, basedOn chains, and docDefaults. */
function parseStyles(xml: string | undefined): StyleInfo {
  const info: StyleInfo = { hidden: new Set(), defaultHidden: false };
  if (!xml) return info;
  const dd = xml.indexOf("<w:docDefaults");
  if (dd !== -1) {
    const end = xml.indexOf("</w:docDefaults>", dd);
    if (end !== -1 && hiddenProps(xml.slice(dd, end))) info.defaultHidden = true;
  }
  const direct = new Map<string, boolean>();
  const based = new Map<string, string>();
  let pos = 0;
  for (;;) {
    const i = xml.indexOf("<w:style ", pos);
    if (i === -1) break;
    const j = xml.indexOf("</w:style>", i);
    if (j === -1) break;
    const block = xml.slice(i, j);
    pos = j + 10;
    const id = /w:styleId="([^"]*)"/.exec(block.slice(0, block.indexOf(">") + 1))?.[1];
    if (!id) continue;
    direct.set(id, hiddenProps(block));
    const b = /<w:basedOn\s+w:val="([^"]*)"/.exec(block)?.[1];
    if (b) based.set(id, b);
  }
  for (const id of direct.keys()) {
    let cur: string | undefined = id;
    for (let depth = 0; cur !== undefined && depth < 12; depth++) {
      if (direct.get(cur)) { info.hidden.add(id); break; }
      cur = based.get(cur);
    }
  }
  return info;
}

/** Removes every <tag ...>...</tag> segment (indexOf scan, linear) and reports whether any held visible text. */
function dropSegments(xml: string, tag: string): { xml: string; hadText: boolean } {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = "";
  let pos = 0;
  let hadText = false;
  for (let i = xml.indexOf(open, pos); i !== -1; i = xml.indexOf(open, pos)) {
    const next = xml[i + open.length];
    if (next !== ">" && next !== " " && next !== "/" && next !== "\n" && next !== "\t") { out += xml.slice(pos, i + open.length); pos = i + open.length; continue; }
    const j = xml.indexOf(close, i);
    if (j === -1) { out += xml.slice(pos, i); pos = xml.length; break; }
    if (/<w:(?:t|delText)(?:\s[^<>]*)?>[^<]+</.test(xml.slice(i, j))) hadText = true;
    out += xml.slice(pos, i);
    pos = j + close.length;
  }
  return { xml: out + xml.slice(pos), hadText };
}

function pieces(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(TEXT_PIECE)) out += m[1] !== undefined ? decodeEntities(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n";
  return out;
}

const hasText = (xml: string): boolean => [...xml.matchAll(TEXT_PIECE)].some((m) => m[1] !== undefined && m[1] !== "");

/** Text of one paragraph, run by run (runs are found with indexOf, never with a regex over an unbounded span). */
function paragraphText(p: string, st: StyleInfo, hidden: { n: number }): string {
  const pStyle = /<w:pStyle\s+w:val="([^"]*)"/.exec(p)?.[1];
  const paragraphHidden = st.defaultHidden || (pStyle !== undefined && st.hidden.has(pStyle));
  let line = "";
  let pos = 0;
  for (;;) {
    const i = p.indexOf("<w:r", pos);
    if (i === -1) break;
    const c = p[i + 4];
    if (c !== ">" && c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "/") { pos = i + 4; continue; } // <w:rPr>, <w:rFonts>...
    const j = p.indexOf("</w:r>", i);
    if (j === -1) break;
    const between = p.slice(pos, i); // text outside any run
    line += paragraphHidden ? "" : pieces(between);
    if (paragraphHidden && hasText(between)) hidden.n++;
    const run = p.slice(i, j);
    pos = j + 6;
    const rStyle = /<w:rStyle\s+w:val="([^"]*)"/.exec(run)?.[1];
    const isHidden = paragraphHidden || hiddenProps(run) || (rStyle !== undefined && st.hidden.has(rStyle));
    if (isHidden) { if (hasText(run)) hidden.n++; } else line += pieces(run);
  }
  const tail = p.slice(pos);
  if (paragraphHidden) { if (hasText(tail)) hidden.n++; return line; }
  return line + pieces(tail);
}

function collectDocxText(xml: string, maxChars: number, styles: StyleInfo = { hidden: new Set(), defaultHidden: false }): { text: string; capped: boolean; hidden: number } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("refused: the document declares a DOCTYPE or entities (not a plain Word document)");
  const hidden = { n: 0 };
  // whole-segment drops first: when in doubt, the segment is not read
  let body = xml;
  for (const tag of ["mc:AlternateContent", "w:del", "w:moveFrom", "w:moveTo"]) {
    const r = dropSegments(body, tag);
    body = r.xml;
    if (r.hadText) hidden.n++;
  }
  const paras = body.split(/<\/w:p>|<w:p(?:\s[^<>]*)?\/>/); // a self-closing <w:p/> is an empty paragraph
  paras.pop(); // text after the last paragraph end is the closing body markup
  const lines: string[] = [];
  let n = 0;
  for (const p of paras) {
    const line = paragraphText(p, styles, hidden);
    lines.push(line);
    n += line.length + 1;
    if (n >= maxChars) break;
  }
  const text = lines.join("\n");
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), capped: true, hidden: hidden.n }
    : { text, capped: n >= maxChars && lines.length < paras.length, hidden: hidden.n };
}

/**
 * Text of word/document.xml: one line per paragraph, w:t runs, w:tab and w:br handled minimally.
 * Tag bodies use [^<>]* (never [^>]*): with many unclosed openers the latter backtracks quadratically.
 */
export function docxXmlToText(xml: string): string {
  return collectDocxText(xml, Infinity).text;
}

// ---- archive: the central directory is the authority --------------------------------------------------------

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

export interface ZipEntry {
  readonly name: string; readonly method: number; readonly flags: number;
  readonly compressedSize: number; readonly uncompressedSize: number; readonly localOffset: number;
}

/**
 * The central directory, validated: no duplicate or unsafe names, bounded entry count; every local header must
 * agree with it; entries must not overlap and must cover the file exactly (no data hidden between entries).
 */
export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid .docx (no zip directory)");
  const total = u16(bytes, eocd + 10);
  if (total === 0xffff) throw new Error("refused: zip64 archives are not supported");
  if (total > ZIP_MAX_ENTRIES) throw new Error(`refused: the archive has more than ${ZIP_MAX_ENTRIES} entries`);
  const cdOffset = u32(bytes, eocd + 16);
  const cdSize = u32(bytes, eocd + 12);
  let off = cdOffset;
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < total; k++) {
    if (off + 46 > bytes.length || u32(bytes, off) !== 0x02014b50) throw new Error("not a valid .docx (corrupt zip directory)");
    const nameLen = u16(bytes, off + 28);
    const extraLen = u16(bytes, off + 30);
    const commentLen = u16(bytes, off + 32);
    const nameBytes = bytes.subarray(off + 46, off + 46 + nameLen);
    if (nameBytes.length !== nameLen) throw new Error("not a valid .docx (corrupt zip directory)");
    const name = new TextDecoder("utf-8").decode(nameBytes);
    if (name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0") || name.split("/").some((p) => p === "..")) {
      throw new Error("refused: the archive has an entry name that is absolute or climbs out of the package");
    }
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error("refused: the archive has duplicate entry names (ambiguous content)");
    seen.add(key);
    entries.push({
      name, flags: u16(bytes, off + 8), method: u16(bytes, off + 10),
      compressedSize: u32(bytes, off + 20), uncompressedSize: u32(bytes, off + 24), localOffset: u32(bytes, off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (off > eocd || (cdSize !== 0 && off - cdOffset !== cdSize)) throw new Error("refused: the zip directory is inconsistent");

  // local headers vs directory; entries must tile [0, cdOffset) exactly
  const spans: Array<{ start: number; end: number }> = [];
  for (const e of entries) {
    const lh = e.localOffset;
    if (lh + 30 > bytes.length || u32(bytes, lh) !== 0x04034b50) throw new Error("not a valid .docx (corrupt local header)");
    const nameLen = u16(bytes, lh + 26);
    const extraLen = u16(bytes, lh + 28);
    const localName = new TextDecoder("utf-8").decode(bytes.subarray(lh + 30, lh + 30 + nameLen));
    if (localName !== e.name) throw new Error("refused: a local header disagrees with the zip directory (name)");
    if (u16(bytes, lh + 8) !== e.method) throw new Error("refused: a local header disagrees with the zip directory (method)");
    const descriptor = (u16(bytes, lh + 6) & 8) !== 0;
    if (!descriptor && (u32(bytes, lh + 18) !== e.compressedSize || u32(bytes, lh + 22) !== e.uncompressedSize)) {
      throw new Error("refused: a local header disagrees with the zip directory (sizes)");
    }
    const dataStart = lh + 30 + nameLen + extraLen;
    let end = dataStart + e.compressedSize;
    if (descriptor) end += u32(bytes, end) === 0x08074b50 ? 16 : 12;
    if (end > cdOffset) throw new Error("refused: an entry runs into the zip directory");
    spans.push({ start: lh, end });
  }
  spans.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const sp of spans) {
    if (sp.start < cursor) throw new Error("refused: zip entries overlap");
    if (sp.start > cursor) throw new Error("refused: the archive has data outside its entries");
    cursor = sp.end;
  }
  if (cursor !== cdOffset) throw new Error("refused: the archive has data outside its entries");
  return entries;
}

/** Entry names from the central directory (validated as above). */
export function zipEntryNames(bytes: Uint8Array): string[] {
  return readCentralDirectory(bytes).map((e) => e.name);
}

/**
 * Inflates one entry located through the directory. Declared sizes only locate the compressed bytes: the loop
 * counts what the inflater really produces, in 16 KB input steps, and stops at the first excess.
 */
function readEntry(bytes: Uint8Array, entry: ZipEntry, fflate: any, limit: number): Uint8Array {
  if ((entry.flags & 1) !== 0) throw new Error(`refused: ${entry.name} is encrypted`);
  const lh = entry.localOffset;
  const start = lh + 30 + u16(bytes, lh + 26) + u16(bytes, lh + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  const budget = Math.min(limit, bytes.length * ZIP_MAX_RATIO + 64 * 1024);
  let produced = 0;
  let refusal: string | undefined;
  let finished = false;
  const chunks: Uint8Array[] = [];
  const take = (chunk: Uint8Array, final: boolean): void => {
    if (refusal || finished) return;
    produced += chunk.length;
    if (produced > budget) {
      refusal = produced > limit
        ? `refused: ${entry.name} is larger than ${Math.floor(limit / 1048576) || 1} MB uncompressed`
        : `refused: ${entry.name} expands more than ${ZIP_MAX_RATIO}:1 (decompression bomb)`;
      return;
    }
    chunks.push(chunk);
    if (final) finished = true;
  };
  if (entry.method === 0) {
    take(data, true);
  } else if (entry.method === 8) {
    const inflater = new fflate.Inflate(take);
    try {
      for (let off = 0; !refusal && !finished; off += 16 * 1024) {
        const stop = Math.min(data.length, off + 16 * 1024);
        inflater.push(data.subarray(off, stop), stop >= data.length);
        if (stop >= data.length) break;
      }
    } catch {
      if (!refusal) throw new Error(`not a valid .docx (could not inflate ${entry.name})`);
    } finally {
      try { inflater.terminate(); } catch { /* done */ }
    }
  } else {
    throw new Error("refused: unsupported compression method");
  }
  if (refusal) throw new Error(refusal);
  if (!finished) throw new Error(`not a valid .docx (${entry.name} is incomplete)`);
  const out = new Uint8Array(produced);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export async function extractDocx(bytes: Uint8Array, load: Loader, maxChars: number): Promise<ExtractResult> {
  let fflate: any;
  try { fflate = await load("fflate"); } catch { throw new Error("DOCX support needs the optional package fflate (npm install fflate)"); }
  const entries = readCentralDirectory(bytes);
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) throw new Error("not a valid .docx (no word/document.xml)");
  const xml = new TextDecoder("utf-8").decode(readEntry(bytes, doc, fflate, DOCX_MAX_UNCOMPRESSED));
  const stylesEntry = entries.find((e) => e.name === "word/styles.xml");
  const styles = parseStyles(stylesEntry ? new TextDecoder("utf-8").decode(readEntry(bytes, stylesEntry, fflate, DOCX_MAX_STYLES)) : undefined);
  const { text, capped, hidden } = collectDocxText(xml, maxChars, styles);
  // a missing root close tag means the XML was cut off (or is not a Word document)
  const cutOff = !/<\/w:document>\s*$/.test(xml.slice(-64));
  const notes = [
    cutOff ? "document text may be truncated: the XML ends early" : "",
    hidden ? `${hidden} hidden or doubtful segment(s) were dropped` : "",
  ].filter(Boolean);
  return { text, capped, note: notes.join("; ") || undefined, ...(hidden ? { hiddenTextDropped: hidden } : {}) };
}

export async function extractPdf(bytes: Uint8Array, load: Loader, maxChars: number): Promise<ExtractResult> {
  let unpdf: any;
  try { unpdf = await load("unpdf"); } catch { throw new Error("PDF support needs the optional package unpdf (npm install unpdf)"); }
  const pdf = await unpdf.getDocumentProxy(bytes);
  try {
    const pages = Math.min(pdf.numPages as number, PDF_MAX_PAGES);
    const parts: string[] = [];
    let n = 0;
    let capped = false;
    for (let i = 1; i <= pages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      // The budget is checked per item: a single page can not make us build more than what is still allowed.
      let s = "";
      for (const it of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
        s += (it.str ?? "") + (it.hasEOL ? "\n" : "");
        if (n + s.length >= maxChars) break;
      }
      parts.push(s);
      n += s.length + 2;
      if (n >= maxChars) { capped = i < pages || n > maxChars; break; }
    }
    let text = parts.join("\n\n");
    if (text.length > maxChars) { text = text.slice(0, maxChars); capped = true; }
    const notes: string[] = [];
    if (!text.trim()) notes.push("no text layer (scanned?)");
    if (!capped && pdf.numPages > PDF_MAX_PAGES) notes.push(`only the first ${PDF_MAX_PAGES} of ${pdf.numPages} pages were read`);
    return { text, capped, note: notes.join("; ") || undefined };
  } finally {
    await pdf.destroy?.();
  }
}
