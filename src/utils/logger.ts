import { redact } from "./redact.js";

const isMcp = () => process.env["PROTON_DRIVE_MCP"] === "1";
const text = (args: unknown[]): string => redact(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));

export const logger = {
  info: (...args: unknown[]) => {
    if (!isMcp()) console.log("[INFO]", text(args));
    else process.stderr.write(`[INFO] ${text(args)}\n`);
  },
  warn: (...args: unknown[]) => {
    process.stderr.write(`[WARN] ${text(args)}\n`);
  },
  error: (...args: unknown[]) => {
    process.stderr.write(`[ERROR] ${text(args)}\n`);
  },
};
