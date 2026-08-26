export type RuntimeMode = "chat" | "code" | "lab" | "research";
export type RuntimeAlias = "general-prod" | "code-prod" | "lab-prod" | "research-prod";
export type RuntimeProviderKind = "managed" | "static";
export type RuntimeState = "provisioning" | "warming" | "ready" | "draining" | "stopped" | "failed";

export const DEFAULT_RUNTIME_PROFILE = "large_96gb";

export function runtimeAliasForMode(mode?: string | null): RuntimeAlias {
  if (mode === "code") return "code-prod";
  if (mode === "lab") return "lab-prod";
  if (mode === "research") return "research-prod";
  return "general-prod";
}

export type RegisteredRuntimeRoute = {
  providerKey: string;
  providerKind: RuntimeProviderKind;
  providerPriority: number;
  workerId: string;
  externalId: string;
  state: RuntimeState;
  endpoint: string;
  healthUrl: string | null;
  profile: string;
  region: string | null;
  gpuType: string | null;
  gpuCount: number | null;
  vramTotalBytes: number | null;
  routePriority: number;
  routeWeight: number;
  lastHealthAt: string | null;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

export type RuntimeInstance = {
  providerKey: string;
  providerKind: RuntimeProviderKind;
  providerPriority: number;
  externalId: string;
  profile: string;
  state: RuntimeState;
  endpoint: string;
  healthUrl: string | null;
  region?: string | null;
  gpuType?: string | null;
  gpuCount?: number | null;
  vramTotalBytes?: number | null;
  routePriority?: number;
  metadata?: Record<string, unknown>;
};

export type RuntimeEnsureRequest = {
  alias: RuntimeAlias;
  profile: string;
  preferred?: RegisteredRuntimeRoute | null;
};

export interface RuntimeProviderAdapter {
  readonly key: string;
  readonly kind: RuntimeProviderKind;
  readonly defaultPriority: number;
  configured(): boolean;
  health(route: RegisteredRuntimeRoute): Promise<boolean>;
  ensure(request: RuntimeEnsureRequest): Promise<RuntimeInstance>;
}

export type EnabledRuntimeProvider = {
  key: string;
  kind: RuntimeProviderKind;
  priority: number;
  configuration: Record<string, unknown>;
};

export interface RuntimeRegistry {
  enabledProviders(): Promise<EnabledRuntimeProvider[]>;
  resolve(alias: RuntimeAlias): Promise<RegisteredRuntimeRoute[]>;
  register(alias: RuntimeAlias, instance: RuntimeInstance): Promise<string>;
  markHealth(providerKey: string, externalId: string, state: RuntimeState, errorCode?: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

export type RuntimeManagerResult = {
  configured: true;
  alias: RuntimeAlias;
  instance: RuntimeInstance;
  reused: boolean;
};

export type PublicRuntimeWakeResult = {
  configured: true;
  alias: RuntimeAlias;
  state: RuntimeState;
  reused: boolean;
};

export function publicRuntimeWake(result: RuntimeManagerResult): PublicRuntimeWakeResult {
  return {
    configured: true,
    alias: result.alias,
    state: result.instance.state,
    reused: result.reused
  };
}
