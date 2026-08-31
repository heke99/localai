import type { GenerateRequest } from "@div3rsa/model-sdk";

export const SECURITY_READINESS_PREFIX = "SECURITY READINESS REQUIRED:";

/**
 * The production readiness harness is the only caller allowed to bypass normal
 * user-facing tool-protocol repair. Match only a system message whose content starts
 * with the reserved prefix; incidental mentions inside skills or other system text
 * must not activate the bypass.
 */
export function isDeterministicSecurityReadiness(request: GenerateRequest): boolean {
  return request.messages.some((message) =>
    message.role === "system" && /^\s*SECURITY READINESS REQUIRED:\s/i.test(message.content)
  );
}
