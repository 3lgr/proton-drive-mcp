import { sanitizeString } from "../policy/untrusted.js";

// Text shown to the human or echoed in errors: control characters and newlines are neutralised and the MIDDLE of a
// long value is elided, so two long names sharing a prefix (or a spoofed line break) stay distinguishable.
export function showValue(v: unknown, head = 120, tail = 60): string {
  // Same category filter as the untrusted-content envelope: what the human reads cannot hide direction overrides,
  // zero-width or tag characters, escape sequences or line breaks.
  const raw = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  const t = sanitizeString(raw, { cap: 1_000_000 }).replace(/\uFFFD/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}…${t.slice(-tail)}` : t;
}
