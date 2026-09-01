import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "infra/runtime/check-search-capability.sh");

async function startServer(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListening());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_search_server_address_missing");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
}

async function runProbe(baseUrl: string, attempts: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn("bash", [scriptPath, baseUrl, "bounded readiness test"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DIV3RSA_SEARCH_HEALTH_MAX_ATTEMPTS: String(attempts),
      DIV3RSA_SEARCH_HEALTH_RETRY_DELAY_SECONDS: "0",
      DIV3RSA_SEARCH_HEALTH_TIMEOUT_SECONDS: "3"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { code, stdout, stderr };
}

describe("search capability readiness", () => {
  it("recovers from transient empty engine results without weakening the usable-result requirement", async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "application/json");
      if (requests < 3) {
        response.end(JSON.stringify({ results: [], unresponsive_engines: [["fixture", "rate limited"]] }));
        return;
      }
      response.end(JSON.stringify({ results: [{ engine: "fixture", title: "usable", url: "https://example.test/" }], unresponsive_engines: [] }));
    });

    try {
      const result = await runProbe(baseUrl, 4);
      expect(result.code).toBe(0);
      expect(requests).toBe(3);
      expect(result.stdout).toContain("usable_results=1");
      expect(result.stdout).toContain("recovered after transient search failure attempt=3/4");
    } finally {
      await closeServer(server);
    }
  });

  it("still fails closed when every bounded attempt returns no usable result", async () => {
    let requests = 0;
    const { server, baseUrl } = await startServer((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ results: [], unresponsive_engines: [["fixture", "captcha"]] }));
    });

    try {
      const result = await runProbe(baseUrl, 2);
      expect(result.code).toBe(1);
      expect(requests).toBe(2);
      expect(result.stderr).toContain("exhausted 2 attempts without a usable search result");
    } finally {
      await closeServer(server);
    }
  });
});
