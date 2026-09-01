import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";

const MAX_TOOL_INPUT_CHARS = 64_000;
const MAX_VALIDATION_DEPTH = 12;

type JsonSchema = Record<string, unknown>;

function schemaError(tool: string, path: string, reason: string): never {
  throw new Error(`tool_input_invalid:${tool}:${path || "$"}:${reason}`);
}

function typeMatches(expected: string, value: unknown): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function validate(schema: JsonSchema, value: unknown, tool: string, path: string, depth: number): void {
  if (depth > MAX_VALIDATION_DEPTH) schemaError(tool, path, "schema_depth_exceeded");

  const expected = schema.type;
  if (typeof expected === "string" && !typeMatches(expected, value)) schemaError(tool, path, `expected_${expected}`);
  if (Array.isArray(expected) && expected.every((candidate) => typeof candidate !== "string" || !typeMatches(candidate, value))) {
    schemaError(tool, path, "type_mismatch");
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) schemaError(tool, path, "enum");

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) schemaError(tool, path, "minLength");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) schemaError(tool, path, "maxLength");
    if (typeof schema.pattern === "string") {
      let expression: RegExp;
      try { expression = new RegExp(schema.pattern); } catch { schemaError(tool, path, "invalid_schema_pattern"); }
      if (!expression.test(value)) schemaError(tool, path, "pattern");
    }
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) schemaError(tool, path, "non_finite_number");
    if (typeof schema.minimum === "number" && value < schema.minimum) schemaError(tool, path, "minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum) schemaError(tool, path, "maximum");
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) schemaError(tool, path, "minItems");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) schemaError(tool, path, "maxItems");
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((entry, index) => validate(schema.items as JsonSchema, entry, tool, `${path}[${index}]`, depth + 1));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required === "string" && !Object.prototype.hasOwnProperty.call(object, required)) schemaError(tool, path ? `${path}.${required}` : required, "required");
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!Object.prototype.hasOwnProperty.call(properties, key)) schemaError(tool, path ? `${path}.${key}` : key, "additional_property");
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(object, key) || !childSchema || typeof childSchema !== "object" || Array.isArray(childSchema)) continue;
      validate(childSchema as JsonSchema, object[key], tool, path ? `${path}.${key}` : key, depth + 1);
    }
  }
}

export function validateToolCallInput(definition: ModelToolDefinition, call: ModelToolCall): void {
  if (definition.name !== call.name) throw new Error(`tool_definition_mismatch:${call.name}`);
  let serialized: string;
  try { serialized = JSON.stringify(call.input); } catch { throw new Error(`tool_input_invalid:${call.name}:$:not_serializable`); }
  if (serialized.length > MAX_TOOL_INPUT_CHARS) throw new Error(`tool_input_too_large:${call.name}`);
  validate(definition.inputSchema ?? {}, call.input, call.name, "", 0);
}
