import { createClient } from "@supabase/supabase-js";
import type { Database } from "@div3rsa/db";
import { RuntimeRegistration, runtimeRegistrationConfigFromEnvironment, type RuntimeRpcClient } from "./runtime-registration";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function numberValue(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_environment_number:${name}`);
  return value;
}

const supabase = createClient<Database>(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
const modelPort = numberValue("DIV3RSA_MODEL_PORT", 8080);
const localHealthUrl = `http://127.0.0.1:${modelPort}/health`;
const config = runtimeRegistrationConfigFromEnvironment(modelPort);
if (!config) throw new Error("runtime_registration_config_required");
if (config.runtimeRole !== "inference") throw new Error("inference_node_role_required");
const registrarId = process.env.DIV3RSA_RUNTIME_REGISTRAR_ID?.trim() || `inference-registrar-${process.pid}`;
const registration = new RuntimeRegistration(supabase as unknown as RuntimeRpcClient, config, registrarId);
const heartbeatMs = Math.max(5_000, numberValue("DIV3RSA_RUNTIME_HEARTBEAT_MS", 30_000));
let stopping = false;

async function localHealthy(): Promise<boolean> {
  try {
    const response = await fetch(localHealthUrl, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function sync(): Promise<void> {
  if (!(await localHealthy())) throw new Error("local_inference_unhealthy");
  const ok = await registration.sync();
  if (!ok) throw new Error("runtime_registration_not_ready");
}

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  try { await registration.drain(`signal:${signal}`); }
  catch (error) { console.error(`[inference-registrar] drain failed: ${error instanceof Error ? error.message : String(error)}`); }
}

process.on("SIGTERM", () => { void stop("SIGTERM"); });
process.on("SIGINT", () => { void stop("SIGINT"); });

await sync();
console.info(`[inference-registrar] READY provider=${config.providerKey} externalId=${config.externalId} profile=${config.profile}`);

while (!stopping) {
  await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
  if (stopping) break;
  try {
    await sync();
  } catch (error) {
    console.error(`[inference-registrar] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    try { await registration.drain("heartbeat_failed"); } catch { /* best effort */ }
  }
}
