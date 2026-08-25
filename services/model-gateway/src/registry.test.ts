import { describe, expect, it } from "vitest";
import { MODEL_ALIASES, QWEN_Q8, QWEN_RUNTIME_MODEL, resolveModel } from "./registry";

describe("model registry", () => {
  it("pins the verified V3 Q8 artifact and immutable revision", () => {
    expect(QWEN_Q8.id).toBe("qwen38-27b-obliterated-v3-q8-0");
    expect(QWEN_Q8.quantization).toBe("Q8_0");
    expect(QWEN_Q8.revision).toBe("768dd4ca58e1af3593605d93abef2c1c45647a07");
    expect(QWEN_Q8.artifactSha256).toBe("afa839b2fa5bc890e5735031dda2c6239d3b6bba3b6ffa29477cbc14a2e1f221");
    expect(QWEN_Q8.artifactBytes).toBe(29047075872);
    expect(QWEN_RUNTIME_MODEL).toBe("localai-qwen38-v3-q8");
  });

  it("routes logical product aliases without model-specific business conditions", () => {
    for (const alias of Object.keys(MODEL_ALIASES) as Array<keyof typeof MODEL_ALIASES>) {
      expect(resolveModel(alias).id).toBe(QWEN_Q8.id);
    }
  });
});
