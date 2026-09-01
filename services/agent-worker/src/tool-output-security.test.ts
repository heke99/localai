import { describe, expect, it } from "vitest";
import { normalizeToolResult } from "./tool-execution-lifecycle";
import { compactToolOutput, sanitizeToolOutput } from "./tool-output";

describe("tool output secret redaction", () => {
  it("redacts sensitive keys recursively while preserving useful observations", () => {
    const safe = sanitizeToolOutput({
      status: "completed",
      data: {
        name: "deployment-1",
        access_token: "super-secret-token",
        nested: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz", state: "READY" }
      }
    }) as Record<string, unknown>;
    const data = safe.data as Record<string, unknown>;
    expect(data.name).toBe("deployment-1");
    expect(data.access_token).toBe("[REDACTED]");
    expect((data.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((data.nested as Record<string, unknown>).state).toBe("READY");
  });

  it("redacts inline bearer tokens, provider tokens and private keys before model context", () => {
    const output = compactToolOutput({
      note: "Authorization Bearer abcdefghijklmnopqrstuvwxyz",
      github: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      key: "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----"
    });
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(output).not.toContain("secret-material");
    expect(output).toContain("[REDACTED]");
  });

  it("sanitizes lifecycle output summaries before persistence", () => {
    const normalized = normalizeToolResult({
      ok: true,
      status: "completed",
      data: { deploymentId: "dpl_123", client_secret: "dont-store-this" }
    });
    expect(normalized.status).toBe("completed");
    expect(normalized.data).toEqual({ deploymentId: "dpl_123", client_secret: "[REDACTED]" });
  });
});
