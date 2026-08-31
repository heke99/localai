import type { GenerateRequest } from "@div3rsa/model-sdk";

export const SECURITY_READINESS_PREFIX = "SECURITY READINESS REQUIRED:";
export const SECURITY_READINESS_SIGNATURE = "SECURITY READINESS REQUIRED: the first model turn MUST call security_scan exactly once. Its JSON schema has already been narrowed to the exact production-readiness operation and target. This marker is reserved for the production readiness harness.";
export const SECURITY_READINESS_USER_PREFIX = "Authorized production-readiness check. Use security_scan exactly once. The tool schema permits exactly one operation and one target.";

function singleStringEnum(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const values = (value as { enum?: unknown }).enum;
  return Array.isArray(values) && values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

function hasNarrowedSecuritySchema(request: GenerateRequest): boolean {
  const security = request.tools?.find((tool) => tool.name === "security_scan");
  const properties = security?.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const fields = properties as Record<string, unknown>;
  return Boolean(singleStringEnum(fields.tool) && singleStringEnum(fields.target));
}

/**
 * The production readiness harness is the only caller allowed to bypass normal
 * user-facing tool-protocol repair. In the worker, skill instructions are appended
 * to a larger system message, so the reserved marker is not necessarily at byte 0.
 * Require the complete unambiguous harness signature, the exact readiness user-prompt
 * prefix, and a security_scan schema narrowed to exactly one operation and one target.
 * Incidental marker mentions therefore cannot activate the bypass.
 */
export function isDeterministicSecurityReadiness(request: GenerateRequest): boolean {
  const hasSignature = request.messages.some((message) =>
    message.role === "system" && message.content.includes(SECURITY_READINESS_SIGNATURE)
  );
  if (!hasSignature || !hasNarrowedSecuritySchema(request)) return false;

  const user = [...request.messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  return user.startsWith(SECURITY_READINESS_USER_PREFIX);
}
