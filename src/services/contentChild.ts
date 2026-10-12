// Entry of the sandboxed parser process for drive_read_content. Started by content.ts with Node's permission model
// (no child processes, no worker threads, no addons, no writes, reads limited to the package and its node_modules),
// an empty environment and a memory cap. It reads one job from stdin, writes one JSON line to stdout, and exits.
//   stdin : <JSON header>\n<raw file bytes>
//   stdout: {"ok":true,text,note,capped} | {"ok":false,error}
import { extractDocx, extractPdf } from "./contentExtract.js";

interface Header { kind: "pdf" | "docx"; maxChars: number; moduleSpecifiers?: Record<string, string> }

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const input = await readStdin();
const nl = input.indexOf(0x0a);
let reply: unknown;
try {
  if (nl < 0) throw new Error("malformed job");
  const header = JSON.parse(input.subarray(0, nl).toString("utf8")) as Header;
  const bytes = new Uint8Array(input.subarray(nl + 1));
  // Optional packages are imported here, never in the parent. moduleSpecifiers is a test hook.
  const load = (name: string): Promise<any> => import(header.moduleSpecifiers?.[name] ?? name);
  const r = header.kind === "pdf" ? await extractPdf(bytes, load, header.maxChars) : await extractDocx(bytes, load, header.maxChars);
  reply = { ok: true, ...r };
} catch (e) {
  reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
}
process.stdout.write(JSON.stringify(reply) + "\n", () => process.exit(0));
