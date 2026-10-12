// What a human reads in an approval prompt (F-01, F-07): values are escaped, never shortened.
import { approvalField } from "../policy/untrusted.js";

export function describeArgs(args: Record<string, unknown>): string {
  // One line per field (and per list item); values are rendered with every non-ASCII character escaped, never shortened.
  return Object.entries(args).filter(([k]) => k !== "confirmed" && args[k] !== undefined).flatMap(([k, v]) =>
    Array.isArray(v) ? v.map((x, i) => `${k}[${i}]: ${approvalField(x)}`) : [`${k}: ${approvalField(v)}`],
  ).join("\n");
}

export function bulkPrompt(tool: string, verb: string, paths: string[], destination?: string): string {
  return `${tool} needs your approval. ${verb} ${paths.length} item(s)${destination ? ` into ${approvalField(destination)}` : ""}.\n` +
    paths.map((p) => `- ${approvalField(p)}`).join("\n");
}

