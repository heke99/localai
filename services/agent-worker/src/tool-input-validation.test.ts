import { describe, expect, it } from "vitest";
import type { ModelToolDefinition } from "@div3rsa/model-sdk";
import { validateToolCallInput } from "./tool-input-validation";

const definition: ModelToolDefinition = {
  name: "write_record",
  description: "test",
  inputSchema: {
    type: "object",
    required: ["resourceId", "count", "mode"],
    additionalProperties: false,
    properties: {
      resourceId: { type: "string", minLength: 1, maxLength: 64 },
      count: { type: "integer", minimum: 1, maximum: 10 },
      mode: { type: "string", enum: ["safe", "fast"] },
      nested: {
        type: "object",
        additionalProperties: false,
        properties: { enabled: { type: "boolean" } }
      }
    }
  }
};

describe("tool input validation", () => {
  it("accepts an input matching the exposed schema", () => {
    expect(() => validateToolCallInput(definition, {
      id: "call-1",
      name: "write_record",
      input: { resourceId: "resource-1", count: 2, mode: "safe", nested: { enabled: true } }
    })).not.toThrow();
  });

  it("rejects missing required properties before execution", () => {
    expect(() => validateToolCallInput(definition, {
      id: "call-2",
      name: "write_record",
      input: { resourceId: "resource-1", count: 2 }
    })).toThrow("tool_input_invalid:write_record:mode:required");
  });

  it("rejects extra properties and invalid scalar constraints", () => {
    expect(() => validateToolCallInput(definition, {
      id: "call-3",
      name: "write_record",
      input: { resourceId: "resource-1", count: 11, mode: "safe" }
    })).toThrow("maximum");
    expect(() => validateToolCallInput(definition, {
      id: "call-4",
      name: "write_record",
      input: { resourceId: "resource-1", count: 1, mode: "safe", surprise: true }
    })).toThrow("additional_property");
  });

  it("rejects oversized model-generated tool payloads", () => {
    const large: ModelToolDefinition = {
      name: "large",
      description: "test",
      inputSchema: { type: "object", properties: { value: { type: "string" } } }
    };
    expect(() => validateToolCallInput(large, {
      id: "call-5",
      name: "large",
      input: { value: "x".repeat(70_000) }
    })).toThrow("tool_input_too_large:large");
  });
});
