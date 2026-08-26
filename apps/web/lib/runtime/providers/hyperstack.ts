import type {
  RegisteredRuntimeRoute,
  RuntimeBootstrapIssuer,
  RuntimeEnsureRequest,
  RuntimeInstance,
  RuntimeProviderAdapter,
  RuntimeState
} from "../contracts";

type HyperstackFlavor = {
  name?: string;
  region_name?: string;
  gpu?: string;
  gpu_count?: number;
  stock_available?: boolean;
};

type HyperstackVm = {
  id?: number;
  name?: string;
  status?: string;
  floating_ip?: string | null;
  environment?: { region?: string; name?: string };
  flavor?: { name?: string; gpu?: string; gpu_count?: number };
};

type HyperstackConfig = {
  apiKey: string;
  apiBase: string;
  environmentName: string;
  keyName: string;
  imageName: string;
  region: string | null;
  flavorPreference: string[];
  publicHostSuffix: string;
  allowSsh: boolean;
  apiTimeoutMs: number;
  healthTimeoutMs: number;
  bootstrapScriptUrl: string;
};

type FetchLike = typeof fetch;

const DEFAULT_API_BASE = "https://infrahub-api.nexgencloud.com/v1";
const DEFAULT_IMAGE = "Ubuntu Server 22.04 LTS R550 CUDA 12.4 with Docker";
const DEFAULT_FLAVORS = [
  "n3-RTX-PRO6000-SEx1",
  "n3-L40x2",
  "n3-RTX-A6000x2",
  "n3-A100x2"
];
const PENDING_ENDPOINT = "https://runtime-pending.invalid/v1";

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuration(): HyperstackConfig | null {
  const apiKey = process.env.HYPERSTACK_API_KEY?.trim();
  const environmentName = process.env.HYPERSTACK_ENVIRONMENT_NAME?.trim();
  const keyName = process.env.HYPERSTACK_KEY_NAME?.trim();
  if (!apiKey || !environmentName || !keyName) return null;
  const flavorPreference = (process.env.HYPERSTACK_GPU_FLAVORS ?? DEFAULT_FLAVORS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!flavorPreference.length) return null;
  return {
    apiKey,
    environmentName,
    keyName,
    apiBase: (process.env.HYPERSTACK_API_BASE_URL?.trim() || DEFAULT_API_BASE).replace(/\/$/, ""),
    imageName: process.env.HYPERSTACK_IMAGE_NAME?.trim() || DEFAULT_IMAGE,
    region: process.env.HYPERSTACK_REGION?.trim() || null,
    flavorPreference,
    publicHostSuffix: process.env.HYPERSTACK_RUNTIME_PUBLIC_HOST_SUFFIX?.trim() || "sslip.io",
    allowSsh: process.env.HYPERSTACK_ALLOW_SSH?.trim() === "1",
    apiTimeoutMs: positiveInteger(process.env.HYPERSTACK_API_TIMEOUT_MS, 8000),
    healthTimeoutMs: positiveInteger(process.env.HYPERSTACK_RUNTIME_HEALTH_TIMEOUT_MS, 3000),
    bootstrapScriptUrl: process.env.HYPERSTACK_BOOTSTRAP_SCRIPT_URL?.trim()
      || "https://raw.githubusercontent.com/heke99/localai/main/infra/runtime/bootstrap-host.sh"
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function ipv4Host(ip: string, suffix: string) {
  if (!/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) throw new Error("hyperstack_invalid_floating_ip");
  const octets = ip.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) throw new Error("hyperstack_invalid_floating_ip");
  if (!/^[A-Za-z0-9.-]+$/.test(suffix)) throw new Error("hyperstack_invalid_public_host_suffix");
  return `${octets.join("-")}.${suffix}`;
}

function publicUrls(ip: string, suffix: string) {
  const host = ipv4Host(ip, suffix);
  return { endpoint: `https://${host}/v1`, healthUrl: `https://${host}/health` };
}

function runtimeState(status: string | undefined): RuntimeState {
  const normalized = status?.toUpperCase() ?? "UNKNOWN";
  if (normalized === "ACTIVE") return "warming";
  if (normalized === "SHUTOFF" || normalized.includes("HIBERNAT")) return "stopped";
  if (normalized.includes("ERROR") || normalized.includes("FAIL")) return "failed";
  return "provisioning";
}

function vmId(route: RegisteredRuntimeRoute) {
  const value = route.metadata.vmId;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function runtimeName(alias: string) {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `div3rsa-${alias.replace(/-prod$/, "")}-${Date.now().toString(36)}-${suffix}`.slice(0, 63);
}

function cloudInit(input: { bootstrapUrl: string; token: string; suffix: string; bootstrapScriptUrl: string }) {
  return [
    "#!/bin/bash",
    "set -Eeuo pipefail",
    `export DIV3RSA_BOOTSTRAP_URL=${shellQuote(input.bootstrapUrl)}`,
    `export DIV3RSA_BOOTSTRAP_TOKEN=${shellQuote(input.token)}`,
    `export DIV3RSA_RUNTIME_PUBLIC_HOST_SUFFIX=${shellQuote(input.suffix)}`,
    `curl --fail --location --silent --show-error ${shellQuote(input.bootstrapScriptUrl)} -o /tmp/div3rsa-runtime-bootstrap.sh`,
    "chmod 700 /tmp/div3rsa-runtime-bootstrap.sh",
    "exec bash /tmp/div3rsa-runtime-bootstrap.sh"
  ].join("\n");
}

export class HyperstackRuntimeProvider implements RuntimeProviderAdapter {
  readonly key = "hyperstack";
  readonly kind = "managed" as const;
  readonly defaultPriority = 200;

  constructor(private readonly bootstrapIssuer: RuntimeBootstrapIssuer, private readonly fetchImpl: FetchLike = fetch) {}

  configured() {
    return configuration() !== null;
  }

  private async request<T>(config: HyperstackConfig, path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("api_key", config.apiKey);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(`${config.apiBase}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(config.apiTimeoutMs)
    });
    if (!response.ok) throw new Error(`hyperstack_api_${response.status}`);
    return await response.json() as T;
  }

  private async probe(url: string, timeoutMs: number) {
    try {
      const response = await this.fetchImpl(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async health(route: RegisteredRuntimeRoute) {
    const config = configuration();
    if (!config || route.providerKey !== this.key || route.state !== "ready") return false;
    if (!route.healthUrl || route.endpoint === PENDING_ENDPOINT) return false;
    return this.probe(route.healthUrl, config.healthTimeoutMs);
  }

  private async findVm(config: HyperstackConfig, route: RegisteredRuntimeRoute): Promise<HyperstackVm | null> {
    const id = vmId(route);
    if (id) {
      try {
        const detail = await this.request<{ instance?: HyperstackVm }>(config, `/core/virtual-machines/${id}`);
        if (detail.instance) return detail.instance;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "hyperstack_api_404") throw error;
      }
    }

    const payload = await this.request<{ instances?: HyperstackVm[] }>(
      config,
      `/core/virtual-machines?search=${encodeURIComponent(route.externalId)}&pageSize=50`
    );
    return (payload.instances ?? []).find((vm) => vm.name === route.externalId) ?? null;
  }

  private async selectFlavor(config: HyperstackConfig) {
    const payload = await this.request<{ flavors?: HyperstackFlavor[] } | HyperstackFlavor[]>(config, "/core/flavors");
    const flavors = Array.isArray(payload) ? payload : payload.flavors ?? [];
    for (const preferred of config.flavorPreference) {
      const match = flavors.find((flavor) =>
        flavor.name === preferred
        && flavor.stock_available === true
        && (!config.region || flavor.region_name === config.region)
      );
      if (match?.name) return match;
    }
    throw new Error("hyperstack_capacity_unavailable");
  }

  private instanceFromVm(config: HyperstackConfig, request: RuntimeEnsureRequest, vm: HyperstackVm, fallbackExternalId: string): RuntimeInstance {
    const externalId = vm.name || fallbackExternalId;
    const state = runtimeState(vm.status);
    const urls = vm.floating_ip ? publicUrls(vm.floating_ip, config.publicHostSuffix) : null;
    return {
      providerKey: this.key,
      providerKind: this.kind,
      providerPriority: this.defaultPriority,
      externalId,
      profile: request.profile,
      state,
      endpoint: urls?.endpoint ?? PENDING_ENDPOINT,
      healthUrl: urls?.healthUrl ?? null,
      region: vm.environment?.region ?? config.region,
      gpuType: vm.flavor?.gpu ?? null,
      gpuCount: typeof vm.flavor?.gpu_count === "number" ? vm.flavor.gpu_count : null,
      routePriority: 100,
      metadata: {
        vmId: vm.id ?? null,
        vmStatus: vm.status ?? null,
        flavor: vm.flavor?.name ?? null,
        runtimeContract: "div3rsa-runtime-v1"
      }
    };
  }

  async ensure(request: RuntimeEnsureRequest): Promise<RuntimeInstance> {
    const config = configuration();
    if (!config) throw new Error("hyperstack_unconfigured");

    if (request.preferred) {
      const vm = await this.findVm(config, request.preferred);
      if (vm) {
        const normalized = vm.status?.toUpperCase() ?? "UNKNOWN";
        if (normalized === "SHUTOFF" && vm.id) {
          await this.request(config, `/core/virtual-machines/${vm.id}/start`, { method: "GET" });
          return { ...this.instanceFromVm(config, request, vm, request.preferred.externalId), state: "warming" };
        }
        if (normalized.includes("HIBERNAT") && vm.id) {
          await this.request(config, `/core/virtual-machines/${vm.id}/hibernate-restore`, { method: "GET" });
          return { ...this.instanceFromVm(config, request, vm, request.preferred.externalId), state: "warming" };
        }
        if (normalized.includes("ERROR") || normalized.includes("FAIL")) throw new Error("hyperstack_vm_failed");

        const instance = this.instanceFromVm(config, request, vm, request.preferred.externalId);
        if (normalized === "ACTIVE" && instance.healthUrl && await this.probe(instance.healthUrl, config.healthTimeoutMs)) {
          return { ...instance, state: "ready" };
        }
        return { ...instance, state: normalized === "ACTIVE" ? "warming" : "provisioning" };
      }
    }

    const flavor = await this.selectFlavor(config);
    const externalId = runtimeName(request.alias);
    const grant = await this.bootstrapIssuer.issue({
      providerKey: this.key,
      alias: request.alias,
      externalId,
      profile: request.profile,
      ttlSeconds: 1800
    });
    const securityRules: Array<Record<string, unknown>> = [
      { direction: "ingress", protocol: "tcp", port_range_min: 80, port_range_max: 80, ethertype: "IPv4", remote_ip_prefix: "0.0.0.0/0" },
      { direction: "ingress", protocol: "tcp", port_range_min: 443, port_range_max: 443, ethertype: "IPv4", remote_ip_prefix: "0.0.0.0/0" }
    ];
    if (config.allowSsh) {
      securityRules.push({ direction: "ingress", protocol: "tcp", port_range_min: 22, port_range_max: 22, ethertype: "IPv4", remote_ip_prefix: "0.0.0.0/0" });
    }

    const payload = await this.request<{ instances?: HyperstackVm[] }>(config, "/core/virtual-machines", {
      method: "POST",
      body: JSON.stringify({
        name: externalId,
        environment_name: config.environmentName,
        image_name: config.imageName,
        flavor_name: flavor.name,
        key_name: config.keyName,
        count: 1,
        assign_floating_ip: true,
        security_rules: securityRules,
        user_data: cloudInit({
          bootstrapUrl: grant.bootstrapUrl,
          token: grant.token,
          suffix: config.publicHostSuffix,
          bootstrapScriptUrl: config.bootstrapScriptUrl
        })
      })
    });
    const vm = payload.instances?.[0];
    if (!vm?.id) throw new Error("hyperstack_create_empty");

    return {
      providerKey: this.key,
      providerKind: this.kind,
      providerPriority: this.defaultPriority,
      externalId,
      profile: request.profile,
      state: "provisioning",
      endpoint: PENDING_ENDPOINT,
      healthUrl: null,
      region: vm.environment?.region ?? flavor.region_name ?? config.region,
      gpuType: vm.flavor?.gpu ?? flavor.gpu ?? null,
      gpuCount: vm.flavor?.gpu_count ?? flavor.gpu_count ?? null,
      routePriority: 100,
      metadata: {
        vmId: vm.id,
        vmStatus: vm.status ?? "CREATING",
        flavor: flavor.name,
        bootstrapExpiresInSeconds: grant.expiresInSeconds,
        runtimeContract: "div3rsa-runtime-v1"
      }
    };
  }
}
