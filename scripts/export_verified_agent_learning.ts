import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { SupabaseAgentKernelStore, type AgentKernelStoreRpcClient } from "../services/agent-worker/src/agent-kernel/store";
import { buildVerifiedLearningDatasetManifest } from "../services/agent-worker/src/agent-kernel/learning-export";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`invalid_environment_integer:${name}`);
  return value;
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
const store = new SupabaseAgentKernelStore(supabase as unknown as AgentKernelStoreRpcClient);
const createdBefore = required("DIV3RSA_LEARNING_EXPORT_CREATED_BEFORE");
const minReward = integerEnvironment("DIV3RSA_LEARNING_EXPORT_MIN_REWARD", 1);
const limit = integerEnvironment("DIV3RSA_LEARNING_EXPORT_LIMIT", 500);
const minimumSamples = integerEnvironment("DIV3RSA_LEARNING_MINIMUM_SAMPLES", 25);
const output = process.env.DIV3RSA_LEARNING_EXPORT_OUTPUT?.trim() || "agent-learning-dataset.json";

const envelope = await store.exportVerifiedLearning({ minReward, limit, createdBefore });
const manifest = buildVerifiedLearningDatasetManifest(envelope, { minimumSamples });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.info(JSON.stringify({
  schemaVersion: manifest.schemaVersion,
  queryVersion: manifest.queryVersion,
  createdBefore: manifest.createdBefore,
  recordCount: manifest.recordCount,
  minimumSamples: manifest.minimumSamples,
  readyForOptimization: manifest.readyForOptimization,
  datasetDigest: manifest.datasetDigest,
  output
}));
