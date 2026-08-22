import { describe, expect, it } from "vitest";
import { MODEL_ALIASES, QWEN_Q8, resolveModel } from "./registry";

describe("model registry", () => {
  it("pins the requested Q8 artifact and immutable revision", () => {
    expect(QWEN_Q8.quantization).toBe("Q8_0");
    expect(QWEN_Q8.revision).toBe("e335d239dbdfae590687e24b800e81a18d070ebe");
    expect(QWEN_Q8.artifactSha256).toBe("4cfb568f17fb58a0373279cc3b73602a350e25aea2953ce087dcea6b51fa6f3c");
    expect(QWEN_Q8.artifactBytes).toBeGreaterThan(27_000_000_000);
  });

  it("routes logical product aliases without model-specific business conditions", () => {
    for (const alias of Object.keys(MODEL_ALIASES) as Array<keyof typeof MODEL_ALIASES>) {
      expect(resolveModel(alias).id).toBe(QWEN_Q8.id);
    }
  });
});
