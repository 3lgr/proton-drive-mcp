// Text extraction for .docx and .pdf. Runs inside contentWorker (a worker_threads Worker with
// memory and time limits); kept free of project imports so the worker starts light.

export const DOCX_MAX_UNCOMPRESSED = 20 * 1024 * 1024;
/** Archive entries a .docx may declare (a real document has a few dozen). Checked while the directory is walked. */
export const ZIP_MAX_ENTRIES = 5_000;
/** word/document.xml may not expand more than this factor (deflate tops out near 1000:1; text sits at 5-20:1). */
export const ZIP_MAX_RATIO = 100;
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

/**
 * Streaming extraction of word/document.xml. Declared sizes in the zip headers are attacker-controlled and are
 * never a decision input: the loop counts the bytes the inflater ACTUALLY produces and stops (terminating the
 * inflater, ceasing to feed input) at the first excess: absolute ceiling, expansion ratio against the archive
 * size, entry count. Nothing is accumulated past the budget.
 */
export async function extractDocx(bytes: Uint8Array, load: Loader, maxChars: number): Promise<ExtractResult> {
  let fflate: any;
  try { fflate = await load("fflate"); } catch { throw new Error("DOCX support needs the optional package fflate (npm install fflate)"); }

  // Entry count from the end-of-central-directory record: a cheap early refusal (the streaming count below still applies).
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      const total = (bytes[i + 10] ?? 0) | ((bytes[i + 11] ?? 0) << 8);
      if (total > ZIP_MAX_ENTRIES) throw new Error(`refused: the archive has more than ${ZIP_MAX_ENTRIES} entries`);
      break;
    }
  }

  const FEED = 16 * 1024; // small input steps so the budget is checked often
  const ratioBudget = Math.min(DOCX_MAX_UNCOMPRESSED, bytes.length * ZIP_MAX_RATIO + 64 * 1024);
  let entries = 0;
  let produced = 0;
  let refusal: string | undefined;
  let found = false;
  let finished = false;
  const chunks: Uint8Array[] = [];

  const unzip = new fflate.Unzip();
  unzip.register(fflate.UnzipInflate);
  unzip.onfile = (file: { name: string; ondata: (err: unknown, chunk: Uint8Array, final: boolean) => void; start: () => void; terminate: () => void }) => {
    if (refusal) return;
    if (++entries > ZIP_MAX_ENTRIES) { refusal = `refused: the archive has more than ${ZIP_MAX_ENTRIES} entries`; return; }
    if (file.name !== "word/document.xml") return; // never started: its data is not inflated
    found = true;
    file.ondata = (err, chunk, final) => {
      if (refusal || finished) return;
      if (err) { refusal = "not a valid .docx (could not unzip)"; return; }
      produced += chunk.length;
      if (produced > ratioBudget) {
        refusal = produced > DOCX_MAX_UNCOMPRESSED
          ? `refused: word/document.xml is larger than ${DOCX_MAX_UNCOMPRESSED / 1048576} MB uncompressed`
          : `refused: word/document.xml expands more than ${ZIP_MAX_RATIO}:1 (decompression bomb)`;
        try { file.terminate(); } catch { /* already stopped */ }
        return;
      }
      chunks.push(chunk);
      if (final) finished = true;
    };
    file.start();
  };

  try {
    for (let off = 0; off < bytes.length && !refusal && !finished; off += FEED) {
      const end = Math.min(bytes.length, off + FEED);
      unzip.push(bytes.subarray(off, end), end >= bytes.length);
    }
  } catch {
    if (!refusal) throw new Error("not a valid .docx (could not unzip)");
  }
  if (refusal) throw new Error(refusal);
  if (!found) throw new Error("not a valid .docx (no word/document.xml)");
  if (!finished) throw new Error("not a valid .docx (word/document.xml is incomplete)");

  const entry = new Uint8Array(produced);
  let at = 0;
  for (const c of chunks) { entry.set(c, at); at += c.length; }
  const xml = new TextDecoder("utf-8").decode(entry);
  const { text, capped } = collectDocxText(xml, maxChars);
  // a missing root close tag means the XML was cut off (or is not a Word document)
  const cutOff = !/<\/w:document>\s*$/.test(xml.slice(-64));
  return { text, capped, note: cutOff ? "document text may be truncated: the XML ends early" : undefined };
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
