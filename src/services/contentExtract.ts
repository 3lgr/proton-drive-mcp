// Text extraction for .docx and .pdf. Runs inside the sandboxed parser process (contentChild); kept free of
// project imports so that process starts light.
//
// WHAT IS EXTRACTED (docx): the visible text of the document BODY, word/document.xml only: w:t text, tabs and breaks,
// one line per paragraph, including text boxes and tracked insertions. Runs marked hidden (w:vanish / w:specVanish)
// are dropped and counted (`hiddenTextDropped`). The fallback branch of mc:AlternateContent is skipped (it duplicates
// the primary branch). NOT extracted: headers, footers, footnotes/endnotes, comments, deleted (tracked) text, field
// codes, document properties, embedded objects and every other part of the package. What a person sees in Word can
// therefore include more than the model receives; what the model receives never includes hidden runs.
// PDF: the text layer as the PDF library returns it. A PDF can carry invisible text (white, tiny, render mode 3);
// that can not be told apart from visible text here, which is one more reason the result is delivered as untrusted.

export const DOCX_MAX_UNCOMPRESSED = 20 * 1024 * 1024;
/** Archive entries a .docx may declare (a real document has a few dozen). Checked while the directory is walked. */
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

/**
 * Text of word/document.xml: one line per paragraph, w:t runs, w:tab and w:br handled minimally.
 * Tag bodies use [^<>]* (never [^>]*): with many unclosed openers the latter backtracks quadratically.
 */
export function docxXmlToText(xml: string): string {
  return collectDocxText(xml, Infinity).text;
}

const TEXT_PIECE = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\b[^<>]*\/?>/g;
const VANISH = /<w:(?:vanish|specVanish)(?:\s+w:val="([^"]*)")?\s*\/?>/;

function isVanished(runXml: string): boolean {
  const m = VANISH.exec(runXml);
  return m !== null && !["0", "false", "off"].includes((m[1] ?? "").toLowerCase());
}

/** Removes every <mc:Fallback>...</mc:Fallback> segment (indexOf scan, linear). */
function dropFallbacks(xml: string): string {
  let out = "";
  let pos = 0;
  for (let i = xml.indexOf("<mc:Fallback"); i !== -1; i = xml.indexOf("<mc:Fallback", pos)) {
    const j = xml.indexOf("</mc:Fallback>", i);
    if (j === -1) break;
    out += xml.slice(pos, i);
    pos = j + "</mc:Fallback>".length;
  }
  return out + xml.slice(pos);
}

function pieces(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(TEXT_PIECE)) out += m[1] !== undefined ? decodeEntities(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n";
  return out;
}

/** Text of one paragraph's XML, run by run (runs are found with indexOf, never with a regex over an unbounded span). */
function paragraphText(p: string, hidden: { n: number }): string {
  let line = "";
  let pos = 0;
  for (;;) {
    const i = p.indexOf("<w:r", pos);
    if (i === -1) break;
    const c = p[i + 4];
    if (c !== ">" && c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "/") { pos = i + 4; continue; } // <w:rPr>, <w:rFonts>...
    const j = p.indexOf("</w:r>", i);
    if (j === -1) break;
    line += pieces(p.slice(pos, i)); // text outside any run
    const run = p.slice(i, j);
    pos = j + 6;
    if (isVanished(run)) {
      if ([...run.matchAll(TEXT_PIECE)].some((m) => m[1] !== undefined && m[1] !== "")) hidden.n++;
    } else {
      line += pieces(run);
    }
  }
  return line + pieces(p.slice(pos));
}

function collectDocxText(xml: string, maxChars: number): { text: string; capped: boolean; hidden: number } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml.slice(0, 4096)) || /<!ENTITY/i.test(xml)) {
    throw new Error("refused: the document declares a DOCTYPE or entities (not a plain Word document)");
  }
  const paras = dropFallbacks(xml).split(/<\/w:p>|<w:p(?:\s[^<>]*)?\/>/); // a self-closing <w:p/> is an empty paragraph
  paras.pop(); // text after the last paragraph end is the closing body markup
  const lines: string[] = [];
  const hidden = { n: 0 };
  let n = 0;
  for (const p of paras) {
    const line = paragraphText(p, hidden);
    lines.push(line);
    n += line.length + 1;
    if (n >= maxChars) break;
  }
  const text = lines.join("\n");
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), capped: true, hidden: hidden.n }
    : { text, capped: n >= maxChars && lines.length < paras.length, hidden: hidden.n };
}

// ---- archive directory (central directory), validated independently of the streaming read -------------------

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

export interface ZipEntry { readonly name: string; readonly method: number; readonly flags: number; readonly compressedSize: number; readonly localOffset: number }

/** The central directory, validated: no duplicate or unsafe names, bounded entry count. */
export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid .docx (no zip directory)");
  const total = u16(bytes, eocd + 10);
  if (total === 0xffff) throw new Error("refused: zip64 archives are not supported");
  if (total > ZIP_MAX_ENTRIES) throw new Error(`refused: the archive has more than ${ZIP_MAX_ENTRIES} entries`);
  let off = u32(bytes, eocd + 16);
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
    entries.push({ name, flags: u16(bytes, off + 8), method: u16(bytes, off + 10), compressedSize: u32(bytes, off + 20), localOffset: u32(bytes, off + 42) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Entry names from the central directory (validated as above). */
export function zipEntryNames(bytes: Uint8Array): string[] {
  return readCentralDirectory(bytes).map((e) => e.name);
}

/**
 * Extraction of word/document.xml. The CENTRAL directory is the only authority: it is validated (no duplicate or
 * unsafe names), the entry is located through it, and its local header must carry the same name, so there is one
 * view of the archive. Declared sizes are never a decision input beyond locating the compressed bytes: the loop
 * counts the bytes the inflater ACTUALLY produces, fed in 16 KB steps, and stops (terminating the inflater, no more
 * input) at the first excess: absolute ceiling or expansion ratio against the archive size.
 */
export async function extractDocx(bytes: Uint8Array, load: Loader, maxChars: number): Promise<ExtractResult> {
  let fflate: any;
  try { fflate = await load("fflate"); } catch { throw new Error("DOCX support needs the optional package fflate (npm install fflate)"); }

  const entry = readCentralDirectory(bytes).find((e) => e.name === "word/document.xml");
  if (!entry) throw new Error("not a valid .docx (no word/document.xml)");
  if ((entry.flags & 1) !== 0) throw new Error("refused: word/document.xml is encrypted");
  const lh = entry.localOffset;
  if (lh + 30 > bytes.length || u32(bytes, lh) !== 0x04034b50) throw new Error("not a valid .docx (corrupt local header)");
  const localName = new TextDecoder("utf-8").decode(bytes.subarray(lh + 30, lh + 30 + u16(bytes, lh + 26)));
  if (localName !== entry.name) throw new Error("refused: the archive's local header disagrees with its directory");
  const start = lh + 30 + u16(bytes, lh + 26) + u16(bytes, lh + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new Error("not a valid .docx (word/document.xml is incomplete)");
  const data = bytes.subarray(start, end);

  const FEED = 16 * 1024;
  const ratioBudget = Math.min(DOCX_MAX_UNCOMPRESSED, bytes.length * ZIP_MAX_RATIO + 64 * 1024);
  let produced = 0;
  let refusal: string | undefined;
  let finished = false;
  const chunks: Uint8Array[] = [];
  const take = (chunk: Uint8Array, final: boolean): void => {
    if (refusal || finished) return;
    produced += chunk.length;
    if (produced > ratioBudget) {
      refusal = produced > DOCX_MAX_UNCOMPRESSED
        ? `refused: word/document.xml is larger than ${DOCX_MAX_UNCOMPRESSED / 1048576} MB uncompressed`
        : `refused: word/document.xml expands more than ${ZIP_MAX_RATIO}:1 (decompression bomb)`;
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
      for (let off = 0; off <= data.length && !refusal && !finished; off += FEED) {
        const stop = Math.min(data.length, off + FEED);
        inflater.push(data.subarray(off, stop), stop >= data.length);
        if (stop >= data.length) break;
      }
    } catch {
      if (!refusal) throw new Error("not a valid .docx (could not inflate word/document.xml)");
    } finally {
      try { inflater.terminate(); } catch { /* done */ }
    }
  } else {
    throw new Error("refused: unsupported compression method");
  }
  if (refusal) throw new Error(refusal);
  if (!finished) throw new Error("not a valid .docx (word/document.xml is incomplete)");

  const out = new Uint8Array(produced);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  const xml = new TextDecoder("utf-8").decode(out);
  const { text, capped, hidden } = collectDocxText(xml, maxChars);
  // a missing root close tag means the XML was cut off (or is not a Word document)
  const cutOff = !/<\/w:document>\s*$/.test(xml.slice(-64));
  const notes = [
    cutOff ? "document text may be truncated: the XML ends early" : "",
    hidden ? `${hidden} hidden run(s) (w:vanish) were dropped` : "",
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
