const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 60;
const MAX_STRING_CHARS = 8_000;
const MAX_DEPTH = 6;
const DEFAULT_MAX_SERIALIZED_CHARS = 12_000;

function compactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return "[tool_result_depth_limited]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[tool_result_cycle]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) items.push({ __truncated_items: value.length - MAX_ARRAY_ITEMS });
      return items;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) output[key] = compactValue(item, depth + 1, seen);
    if (entries.length > MAX_OBJECT_KEYS) output.__truncated_keys = entries.length - MAX_OBJECT_KEYS;
    return output;
  } finally {
    seen.delete(value);
  }
}

export function compactToolOutput(value: unknown, maxSerializedChars = DEFAULT_MAX_SERIALIZED_CHARS): string {
  const safeLimit = Math.max(256, maxSerializedChars);
  let serialized: string;
  try {
    serialized = JSON.stringify(compactValue(value, 0, new WeakSet<object>()));
  } catch {
    serialized = JSON.stringify({ error: "tool_result_not_serializable" });
  }
  if (serialized.length <= safeLimit) return serialized;
  const previewChars = Math.max(16, Math.min(4_000, Math.floor(safeLimit / 3)));
  const fallback = JSON.stringify({ __truncated: true, originalChars: serialized.length, preview: serialized.slice(0, previewChars) });
  if (fallback.length <= safeLimit) return fallback;
  return JSON.stringify({ __truncated: true, originalChars: serialized.length });
}
