import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

describe("Docker tool-network contract", () => {
  it.each([
    "infra/docker/model-worker.compose.yaml",
    "infra/docker/agent-worker.external.compose.yaml"
  ])("wires search and controlled egress in %s", async (path) => {
    const compose = await text(path);
    expect(compose).toContain("DIV3RSA_SEARCH_BASE_URL: http://searxng:8080");
    expect(compose).toContain("DIV3RSA_EGRESS_PROXY_URL: \"${DIV3RSA_EGRESS_PROXY_URL:-http://egress-proxy:3128}\"");
    expect(compose).toContain("NODE_USE_ENV_PROXY: \"${NODE_USE_ENV_PROXY:-1}\"");
    expect(compose).toContain("HTTP_PROXY: \"${HTTP_PROXY:-http://egress-proxy:3128}\"");
    expect(compose).toContain("HTTPS_PROXY: \"${HTTPS_PROXY:-http://egress-proxy:3128}\"");
    expect(compose).toContain("searxng:");
    expect(compose).toContain("egress-proxy:");
    expect(compose).toContain("../search/searxng/settings-proxied.yml:/etc/searxng/settings.yml:ro");
  });

  it("keeps local Qwen and tool services out of the global proxy path", async () => {
    const compose = await text("infra/docker/model-worker.compose.yaml");
    expect(compose).toContain("QWEN_INFERENCE_BASE_URL: http://qwen-v3-q8:8080/v1");
    expect(compose).toContain("NO_PROXY: \"${NO_PROXY:-localhost,127.0.0.1,::1,qwen-v3-q8,searxng,egress-proxy,browser-executor}\"");
    expect(compose).toContain("qwen-v3-q8:\n        condition: service_healthy");
    expect(compose).toContain("searxng:\n        condition: service_healthy");
    expect(compose).toContain("egress-proxy:\n        condition: service_healthy");
  });

  it("keeps browser execution opt-in and private to the compose network", async () => {
    const compose = await text("infra/docker/model-worker.compose.yaml");
    expect(compose).toContain('profiles: ["browser"]');
    expect(compose).toContain('DIV3RSA_BROWSER_EXECUTOR_URL: "${DIV3RSA_BROWSER_EXECUTOR_URL:-}"');
    expect(compose).toContain('DIV3RSA_BROWSER_EXECUTOR_TOKEN: "${DIV3RSA_BROWSER_EXECUTOR_TOKEN:-}"');
    expect(compose).toContain("expose:\n      - \"7320\"");
    expect(compose).not.toContain("7320:7320");
    expect(compose).not.toContain("3128:3128");
  });

  it("routes SearXNG engine traffic through the controlled proxy", async () => {
    const settings = await text("infra/search/searxng/settings-proxied.yml");
    expect(settings).toContain("proxies:");
    expect(settings).toContain("all://:");
    expect(settings).toContain("http://egress-proxy:3128");
  });
});
