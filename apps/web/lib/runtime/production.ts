import "server-only";
import type { RuntimeAlias, RuntimeProviderAdapter } from "./contracts";
import { SupabaseRuntimeBootstrapIssuer } from "./bootstrap-issuer";
import { RuntimeManager } from "./manager";
import { HyperstackRuntimeProvider } from "./providers/hyperstack";
import { OpenAiCompatibleRuntimeProvider } from "./providers/openai-compatible";
import { RunpodRuntimeProvider } from "./providers/runpod";
import { SupabaseRuntimeRegistry } from "./supabase-registry";

let productionManager: RuntimeManager | null = null;

function providerOrder() {
  return (process.env.DIV3RSA_RUNTIME_PROVIDER_ORDER ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function configuredAdapters() {
  const bootstrapIssuer = new SupabaseRuntimeBootstrapIssuer();
  const adapters: RuntimeProviderAdapter[] = [
    new RunpodRuntimeProvider(),
    new HyperstackRuntimeProvider(bootstrapIssuer)
  ];
  try {
    const generic = new OpenAiCompatibleRuntimeProvider();
    // Force key validation here so an invalid optional provider never prevents
    // managed providers from serving production traffic.
    void generic.key;
    adapters.push(generic);
  } catch (error) {
    console.warn("[runtime-manager] optional generic provider ignored", error instanceof Error ? error.message : "invalid_configuration");
  }
  return adapters;
}

function manager() {
  if (!productionManager) {
    productionManager = new RuntimeManager(
      new SupabaseRuntimeRegistry(),
      configuredAdapters(),
      {
        profile: process.env.DIV3RSA_RUNTIME_PROFILE?.trim() || "large_96gb",
        providerOrder: providerOrder(),
        cacheMs: Number(process.env.DIV3RSA_RUNTIME_ROUTE_CACHE_MS ?? "15000") || 15000
      }
    );
  }
  return productionManager;
}

export function ensureModelRuntime(alias: RuntimeAlias) {
  return manager().ensure(alias);
}
