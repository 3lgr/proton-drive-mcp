import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-operation scratch directories (pdmcp-read-*, pdmcp-stage-*...) that currently exist under `tmp`.
 * The server keeps them inside ONE random directory per process (`pdmcp-XXXXXX`); this flattens that level.
 */
export function scratchDirs(tmp, prefix = "pdmcp-") {
  let top = [];
  try { top = readdirSync(tmp).filter((n) => /^pdmcp-[A-Za-z0-9]{6}$/.test(n)); } catch { return []; }
  return top.flatMap((t) => { try { return readdirSync(join(tmp, t)).filter((n) => n.startsWith(prefix)).map((n) => join(t, n)); } catch { return []; } });
}
