import { sanitizeString } from "../policy/untrusted.js";

// Text shown to the human or echoed in errors: control characters and newlines are neutralised and the MIDDLE of a
// long value is elided, so two long names sharing a prefix (or a spoofed line break) stay distinguishable.
export function showValue(v: unknown, head = 120, tail = 60): string {
  // Same linear sanitiser as the untrusted-content envelope (markers instead of silent removal), then the middle of
  // a long value is elided. For approval prompts use renderForApproval(), which never shortens.
  const raw = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  const t = sanitizeString(raw, { cap: head + tail + 4096 }).replace(/\n/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}\u2026${t.slice(-tail)}` : t;
}
