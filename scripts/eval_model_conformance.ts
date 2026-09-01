import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelAlias, ModelCapability } from "@div3rsa/model-sdk";
import { createInferenceAdapter, modelProtocolProfileFromEnvironment, runModelConformance } from "@div3rsa/model-gateway";

function requiredAny(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`missing_environment:${names.join("_or_")}`);
}

const modelPort = Number(process.env.DIV3RSA_MODEL_PORT ?? "6006");
if (!Number.isInteger(modelPort) || modelPort < 1 || modelPort > 65535) throw new Error("invalid_model_port");
const inferenceBaseUrl = process.env.DIV3RSA_INFERENCE_BASE_URL?.trim()
  || process.env.QWEN_INFERENCE_BASE_URL?.trim()
  || `http://127.0.0.1:${modelPort}/v1`;
const inferenceApiKey = requiredAny(["DIV3RSA_INFERENCE_API_KEY", "QWEN_INFERENCE_API_KEY"]);
const profile = modelProtocolProfileFromEnvironment();
const adapter = createInferenceAdapter({ baseUrl: inferenceBaseUrl, apiKey: inferenceApiKey, profile });
const requiredCapabilities = (process.env.DIV3RSA_MODEL_CONFORMANCE_REQUIRED_CAPABILITIES?.trim() || "general,tool_use")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean) as ModelCapability[];
const report = await runModelConformance(adapter, profile, {
  alias: (process.env.DIV3RSA_MODEL_CONFORMANCE_ALIAS?.trim() || "general-prod") as ModelAlias,
  tokenSeed: process.env.DIV3RSA_MODEL_CONFORMANCE_TOKEN?.trim() || undefined,
  requiredCapabilities
});
const summary = {
  ...report,
  generatedAt: new Date().toISOString(),
  repositoryCommit: process.env.DIV3RSA_EVAL_COMMIT_SHA?.trim() || null,
  inferenceBaseUrl: new URL(inferenceBaseUrl).origin
};
const outputPath = process.env.DIV3RSA_MODEL_CONFORMANCE_OUTPUT?.trim();
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(summary, null, 2));
if (!summary.allowed) process.exitCode = 2;
