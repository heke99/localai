export function extractPortabilityBundle(input: unknown): unknown {
  if (!input || Array.isArray(input) || typeof input !== "object") return input;
  const root = input as Record<string, unknown>;
  if (root.bundle != null) return root.bundle;
  if (root.data && !Array.isArray(root.data) && typeof root.data === "object") {
    const data = root.data as Record<string, unknown>;
    if (data.bundle != null) return data.bundle;
  }
  return input;
}
