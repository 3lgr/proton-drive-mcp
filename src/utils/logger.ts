// Log lines are `message` (developer-authored, constant text) plus values. Values pass through safeValue():
// numbers and booleans as they are, everything else as a length+hash marker or a class name. See safeOutput.ts.
import { safeValue } from "./safeOutput.js";
import { redact } from "./redact.js";

const isMcp = () => process.env["PROTON_DRIVE_MCP"] === "1";
const line = (message: string, values: unknown[]): string =>
  redact([message, ...values.map(safeValue)].join(" ")); // redact(): second layer only

export const logger = {
  info: (message: string, ...values: unknown[]) => {
    if (!isMcp()) console.log("[INFO]", line(message, values));
    else process.stderr.write(`[INFO] ${line(message, values)}\n`);
  },
  warn: (message: string, ...values: unknown[]) => {
    process.stderr.write(`[WARN] ${line(message, values)}\n`);
  },
  error: (message: string, ...values: unknown[]) => {
    process.stderr.write(`[ERROR] ${line(message, values)}\n`);
  },
};
