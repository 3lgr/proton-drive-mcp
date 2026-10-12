// Declared-schema enforcement for tool arguments.
export type JsonSchemaProp = { type?: string; enum?: readonly unknown[]; items?: { type?: string }; minimum?: number; maximum?: number; maxItems?: number };
export type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, JsonSchemaProp>; required?: readonly string[]; additionalProperties?: boolean };
  annotations?: Record<string, boolean>;
  title?: string;
};

// The schemas advertise additionalProperties:false, but nothing enforced it, and
// String() coercion let e.g. an array pass as a path. Enforce the declared schema.
export function checkArgs(def: ToolDef, a: Record<string, unknown>): string | undefined {
  const props = def.inputSchema.properties;
  for (const k of Object.keys(a)) {
    if (!(k in props)) return `Unknown argument '${k}'. Allowed: ${Object.keys(props).join(", ") || "(none)"}.`;
  }
  for (const k of def.inputSchema.required ?? []) {
    if (a[k] === undefined || a[k] === null) return `Missing required argument '${k}'.`;
  }
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (v === undefined || v === null || !p) continue;
    if (p.type === "string" && typeof v !== "string") return `${k} must be a string.`;
    if (p.type === "boolean" && typeof v !== "boolean") return `${k} must be a boolean.`;
    if (p.type === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) return `${k} must be an integer.`;
      if (p.minimum !== undefined && v < p.minimum) return `${k} must be >= ${p.minimum}.`;
      if (p.maximum !== undefined && v > p.maximum) return `${k} must be <= ${p.maximum}.`;
    }
    if (p.type === "array") {
      if (!Array.isArray(v)) return `${k} must be an array.`;
      if (p.items?.type === "string" && v.some((x) => typeof x !== "string")) return `${k} must be an array of strings.`;
      if (p.maxItems !== undefined && v.length > p.maxItems) return `${k} has ${v.length} items; the limit is ${p.maxItems} per call.`;
    }
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of: ${p.enum.join(", ")}.`;
  }
  return undefined;
}

