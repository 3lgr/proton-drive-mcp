// Text extraction for .docx and .pdf. Runs inside contentWorker (a worker_threads Worker with
// memory and time limits); kept free of project imports so the worker starts light.

export const DOCX_MAX_UNCOMPRESSED = 20 * 1024 * 1024;
/** Archive entries a .docx may declare (a real document has a few dozen). Checked while the directory is walked. */
export const ZIP_MAX_ENTRIES = 5_000;
/** word/document.xml may not expand more than this factor (deflate tops out near 1000:1; text sits at 5-20:1). */
export const ZIP_MAX_RATIO = 100;
/** Sum of every declared uncompressed size in the archive, whether or not we extract it. */
export const ZIP_MAX_DECLARED_TOTAL = 200 * 1024 * 1024;
export const PDF_MAX_PAGES = 100;

export interface ExtractResult { text: string; note?: string; capped: boolean }
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

function collectDocxText(xml: string, maxChars: number): { text: string; capped: boolean } {
  const paras = xml.split(/<\/w:p>|<w:p(?:\s[^<>]*)?\/>/); // a self-closing <w:p/> is an empty paragraph
  paras.pop(); // text after the last paragraph end is the closing body markup
  const run = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\b[^<>]*\/?>/g;
  const lines: string[] = [];
  let n = 0;
  for (const p of paras) {
    let line = "";
    for (const m of p.matchAll(run)) line += m[1] !== undefined ? decodeEntities(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n";
    lines.push(line);
    n += line.length + 1;
    if (n >= maxChars) break;
  }
  const text = lines.join("\n");
  return text.length > maxChars ? { text: text.slice(0, maxChars), capped: true } : { text, capped: n >= maxChars && lines.length < paras.length };
}

export async function extractDocx(bytes: Uint8Array, load: Loader, maxChars: number): Promise<ExtractResult> {
  let fflate: any;
  try { fflate = await load("fflate"); } catch { throw new Error("DOCX support needs the optional package fflate (npm install fflate)"); }
  let tooBig = false;
  let tooMany = false;
  let tooDense = false;
  let tooLarge = false;
  let declared = -1;
  let entries = 0;
  let declaredTotal = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = fflate.unzipSync(bytes, {
      filter: (f: { name: string; size: number; originalSize: number }) => {
        // Every entry is counted and measured from its header; nothing is inflated for entries we do not want.
        if (++entries > ZIP_MAX_ENTRIES) { tooMany = true; return false; }
        declaredTotal += f.originalSize;
        if (declaredTotal > ZIP_MAX_DECLARED_TOTAL) { tooLarge = true; return false; }
        if (f.name !== "word/document.xml") return false;
        if (f.originalSize > DOCX_MAX_UNCOMPRESSED) { tooBig = true; return false; }
        if (f.originalSize > 256 * 1024 && f.originalSize / Math.max(1, f.size) > ZIP_MAX_RATIO) { tooDense = true; return false; }
        declared = f.originalSize;
        return !tooMany && !tooLarge;
      },
    });
  } catch {
    throw new Error("not a valid .docx (could not unzip)");
  }
  if (tooMany) throw new Error(`refused: the archive has more than ${ZIP_MAX_ENTRIES} entries`);
  if (tooLarge) throw new Error(`refused: the archive declares more than ${ZIP_MAX_DECLARED_TOTAL / 1048576} MB uncompressed in total`);
  if (tooDense) throw new Error(`refused: word/document.xml expands more than ${ZIP_MAX_RATIO}:1 (decompression bomb)`);
  if (tooBig) throw new Error(`refused: word/document.xml is larger than ${DOCX_MAX_UNCOMPRESSED / 1048576} MB uncompressed`);
  const entry = files["word/document.xml"];
  if (!entry) throw new Error("not a valid .docx (no word/document.xml)");
  const xml = new TextDecoder("utf-8").decode(entry);
  const { text, capped } = collectDocxText(xml, maxChars);
  // fflate sizes its output buffer from the (attacker-controlled) declared size and silently stops at it, so
  // a lying size yields a cut-off document with matching lengths; a missing root close tag is the tell.
  const cutOff = entry.length !== declared || !/<\/w:document>\s*$/.test(xml.slice(-64));
  return { text, capped, note: cutOff ? "document text may be truncated: size mismatch" : undefined };
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
      const s = tc.items.map((it: { str?: string; hasEOL?: boolean }) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("");
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
