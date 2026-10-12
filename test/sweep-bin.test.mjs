// N-07: the sweeper never removes pdmcp-bin-* (the verified CLI copy another running instance executes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTempDirs } from "../dist/utils/tempSweep.js";

describe("N-07 sweeper and the verified binary copy", () => {
  it("an old pdmcp-bin-* directory survives; an old pdmcp-read-* directory does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sweepbin-"));
    try {
      const bin = join(dir, "pdmcp-bin-abc123");
      const read = join(dir, "pdmcp-read-abc123");
      for (const d of [bin, read]) { mkdirSync(d); writeFileSync(join(d, "x"), "x"); const t = new Date(Date.now() - 5 * 3600_000); utimesSync(d, t, t); }
      await sweepStaleTempDirs(dir, 3600_000);
      assert.equal(existsSync(bin), true, "the sibling instance's verified binary must stay");
      assert.equal(existsSync(read), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
