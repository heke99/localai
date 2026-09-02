const bearerPattern = /((?:["']?authorization["']?\s*[:=]\s*["']?\s*bearer\s+))([^"'\s,}]+)/gi;
const apiKeyPattern = /((?:["']?(?:x-api-key|api[-_]?key|apikey)["']?\s*[:=]\s*["']?))([^"'\s,}]+)/gi;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactSensitiveText(value: string): string {
  return value
    .replace(bearerPattern, "$1[REDACTED]")
    .replace(apiKeyPattern, "$1[REDACTED]")
    .replace(jwtPattern, "[REDACTED_JWT]");
}
