import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleRuntimeProvider } from "./openai-compatible";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("OpenAiCompatibleRuntimeProvider", () => {
  it("requires HTTPS for non-local runtime endpoints", () => {
    process.env.GENERIC_RUNTIME_BASE_URL = "http://gpu.example/v1";
    const provider = new OpenAiCompatibleRuntimeProvider();
    expect(() => provider.configured()).toThrow("generic_runtime_https_required");
  });

  it("rejects endpoint URLs containing embedded credentials", () => {
    process.env.GENERIC_RUNTIME_BASE_URL = "https://user:password@gpu.example/v1";
    const provider = new OpenAiCompatibleRuntimeProvider();
    expect(() => provider.configured()).toThrow("generic_runtime_url_must_not_contain_credentials");
  });

  it("requires the full provider-neutral runtime contract and keeps credentials out of metadata", async () => {
    process.env.GENERIC_RUNTIME_BASE_URL = "https://gpu.example/v1";
    process.env.GENERIC_RUNTIME_API_KEY = "super-secret-token";
    process.env.GENERIC_RUNTIME_CONTRACT = "div3rsa-runtime-v1";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const provider = new OpenAiCompatibleRuntimeProvider();

    const instance = await provider.ensure({ alias: "general-prod", profile: "large_96gb" });

    expect(instance.state).toBe("warming");
    expect(instance.metadata).toEqual({
      adapter: "openai-compatible",
      lifecycle: "externally-managed",
      contract: "div3rsa-runtime-v1"
    });
    expect(JSON.stringify(instance)).not.toContain("super-secret-token");
  });
});
