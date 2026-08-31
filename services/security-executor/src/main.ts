import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LinuxSecurityExecutor, bearerMatches, type SecurityExecutorRequest } from "./runtime";

const MAX_BODY_BYTES = 64 * 1024;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid_environment_integer:${name}`);
  return value;
}

async function readJson(request: IncomingMessage): Promise<SecurityExecutorRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("security_executor_request_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as SecurityExecutorRequest;
  } catch {
    throw new Error("security_executor_invalid_json");
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

const token = required("DIV3RSA_SECURITY_EXECUTOR_TOKEN");
const readinessToken = process.env.DIV3RSA_SECURITY_READINESS_TOKEN?.trim() || null;
const host = process.env.DIV3RSA_SECURITY_EXECUTOR_HOST?.trim() || "127.0.0.1";
const port = integerEnvironment("DIV3RSA_SECURITY_EXECUTOR_PORT", 7319);
const executor = new LinuxSecurityExecutor({
  auditLogPath: process.env.DIV3RSA_SECURITY_AUDIT_LOG?.trim() || "/var/log/div3rsa/security-executor.jsonl",
  wordlistPath: process.env.DIV3RSA_SECURITY_WORDLIST?.trim() || null,
  maxOutputBytes: integerEnvironment("DIV3RSA_SECURITY_MAX_OUTPUT_BYTES", 512_000),
  readinessToken,
  terminateGraceMs: integerEnvironment("DIV3RSA_SECURITY_TERMINATE_GRACE_MS", 750)
});

const server = createServer(async (request, response) => {
  const executionController = new AbortController();
  let executing = false;
  const abortExecution = () => {
    if (executing && !executionController.signal.aborted) executionController.abort(new DOMException("Client disconnected", "AbortError"));
  };
  request.once("aborted", abortExecution);
  response.once("close", () => {
    if (!response.writableEnded) abortExecution();
  });

  try {
    if (request.method === "GET" && request.url === "/health") {
      const capabilities = await executor.capabilities();
      return json(response, capabilities.ready ? 200 : 503, {
        ok: capabilities.ready,
        service: "security-executor",
        isolation: "allowlisted-process",
        capabilities
      });
    }
    if (request.method === "GET" && request.url === "/v1/capabilities") {
      if (!bearerMatches(request.headers.authorization, token)) return json(response, 401, { error: "unauthorized" });
      return json(response, 200, await executor.capabilities());
    }
    if (request.method !== "POST" || request.url !== "/v1/execute") return json(response, 404, { error: "not_found" });
    if (!bearerMatches(request.headers.authorization, token)) return json(response, 401, { error: "unauthorized" });
    const input = await readJson(request);
    executing = true;
    const result = await executor.execute(input, executionController.signal);
    executing = false;
    return json(response, 200, result);
  } catch (error) {
    executing = false;
    const message = error instanceof Error ? error.message : "security_executor_failed";
    if (executionController.signal.aborted) return;
    const status = /scope|target|tool|option|class|timeout|invalid|blocked|required/.test(message) ? 400 : 500;
    return json(response, status, { error: message.slice(0, 180) });
  }
});

server.requestTimeout = 100_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(port, host, () => {
  console.info(`[security-executor] listening host=${host} port=${port}`);
});

function stop() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
