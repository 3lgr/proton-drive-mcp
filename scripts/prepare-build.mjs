#!/usr/bin/env node
// `prepare` runs after `npm install` from a git checkout (npm i -g github:3lgr/proton-drive-mcp#<tag>) so dist/ exists.
// It does nothing in a published tarball (no src/) and when devDependencies are not installed (npm ci --omit=dev).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(join(root, "src")) || !existsSync(tsc)) process.exit(0);
const r = spawnSync(process.execPath, [tsc], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
