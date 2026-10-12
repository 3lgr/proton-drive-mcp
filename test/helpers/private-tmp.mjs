import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let seq = 0;
/**
 * Gives each test its own TMPDIR so tests that count or glob temp dirs only see their own.
 * Pass the node:test `beforeEach`/`afterEach` hooks.
 */
export function usePrivateTmp(beforeEach, afterEach) {
  let prev, dir;
  beforeEach(() => { prev = process.env.TMPDIR; dir = mkdtempSync(join(realpathSync(tmpdir()), `pdmcp-private-${process.pid}-${seq++}-`)); process.env.TMPDIR = dir; });
  afterEach(() => { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; rmSync(dir, { recursive: true, force: true }); });
}
