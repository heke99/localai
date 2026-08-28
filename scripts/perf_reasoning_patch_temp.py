from pathlib import Path

adapter_path = Path("services/model-gateway/src/openai-compatible-adapter.ts")
adapter = adapter_path.read_text()
old = '''  // Qwen3.8 defaults to its deepest reasoning level when no effort is supplied.\n  // Keep full reasoning for DEEP/CRITICAL work, but avoid paying that latency on\n  // normal STANDARD or FAST requests. llama.cpp maps `none` to\n  // enable_thinking=false and forwards the explicit effort into the Qwen chat\n  // template for the remaining levels.\n  if (fast && stable && !freshnessRequired) return "none";\n  if (fast) return "low";\n  if (standard) return "medium";\n  if (deep || critical) return "xhigh";\n  return undefined;'''
new = '''  // Measured on the production p8 runtime: stable FAST work becomes much\n  // faster when hidden reasoning is disabled, while low/medium did not reduce\n  // STANDARD visible-token latency. Preserve the model's default STANDARD\n  // reasoning rather than changing quality for no measured latency benefit.\n  if (fast && stable && !freshnessRequired) return "none";\n  if (fast) return "low";\n  if (standard) return undefined;\n  if (deep || critical) return "xhigh";\n  return undefined;'''
if adapter.count(old) != 1:
    raise SystemExit(f"expected one reasoning block, found {adapter.count(old)}")
adapter_path.write_text(adapter.replace(old, new, 1))

test_path = Path("services/model-gateway/src/fast-reasoning-routing.test.ts")
test = test_path.read_text()
old_test = '''  it("uses medium reasoning for STANDARD work", async () => {\n    const body = await bodyFor([\n      { role: "system", content: "Task risk: medium. Reasoning policy: STANDARD: decompose material subproblems. STABLE INFORMATION: external research is optional. Research depth: none." },\n      { role: "user", content: "Analyze this architecture tradeoff." }\n    ], []);\n    expect(body.reasoning_effort).toBe("medium");\n  });'''
new_test = '''  it("preserves the model default for STANDARD work when lower efforts do not improve measured latency", async () => {\n    const body = await bodyFor([\n      { role: "system", content: "Task risk: medium. Reasoning policy: STANDARD: decompose material subproblems. STABLE INFORMATION: external research is optional. Research depth: none." },\n      { role: "user", content: "Analyze this architecture tradeoff." }\n    ], []);\n    expect(body.reasoning_effort).toBeUndefined();\n  });'''
if test.count(old_test) != 1:
    raise SystemExit(f"expected one STANDARD test, found {test.count(old_test)}")
test_path.write_text(test.replace(old_test, new_test, 1))
