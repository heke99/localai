import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { assertBrowserUrlAllowed, scopeFingerprint, type BrowserScope } from "./policy";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 64_000;
const MAX_SCREENSHOT_BYTES = 2_000_000;
const SESSION_TTL_MS = 5 * 60_000;
const MAX_SESSIONS = 16;
const PASSIVE_ACTIONS = new Set(["browser_navigate", "browser_read", "browser_screenshot"]);
const ACTIVE_ACTIONS = new Set(["browser_click", "browser_type"]);

type BrowserAction = "browser_navigate" | "browser_read" | "browser_click" | "browser_type" | "browser_screenshot";

interface BrowserExecutorRequest {
  runId: string;
  requestId: string;
  traceId: string;
  action: BrowserAction;
  timeoutMs: number;
  executionClass: "passive" | "active";
  scope: BrowserScope;
  input: Record<string, unknown>;
}

interface Session {
  context: BrowserContext;
  page: Page;
  scopeKey: string;
  lastUsedAt: number;
}

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

function bearerMatches(header: string | undefined, expected: string): boolean {
  const value = header?.replace(/^Bearer\s+/i, "").trim();
  if (!value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<BrowserExecutorRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("browser_request_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as BrowserExecutorRequest;
  } catch {
    throw new Error("browser_invalid_json");
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

function validateRequest(input: BrowserExecutorRequest): void {
  if (!input || typeof input !== "object") throw new Error("browser_invalid_request");
  if (!input.runId || !input.requestId || !input.traceId) throw new Error("browser_run_context_required");
  if (!PASSIVE_ACTIONS.has(input.action) && !ACTIVE_ACTIONS.has(input.action)) throw new Error("browser_action_not_allowed");
  const expectedClass = ACTIVE_ACTIONS.has(input.action) ? "active" : "passive";
  if (input.executionClass !== expectedClass) throw new Error("browser_execution_class_mismatch");
  if (!input.scope?.scopeId || !Array.isArray(input.scope.allowHosts) || !Array.isArray(input.scope.allowIpv4Cidrs)) throw new Error("browser_scope_required");
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 60_000) throw new Error("browser_invalid_timeout");
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`browser_${name}_required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) throw new Error(`browser_invalid_${name}`);
  return normalized;
}

const token = required("DIV3RSA_BROWSER_EXECUTOR_TOKEN");
const proxyUrl = required("DIV3RSA_EGRESS_PROXY_URL");
const listenHost = process.env.DIV3RSA_BROWSER_EXECUTOR_HOST?.trim() || "0.0.0.0";
const listenPort = integerEnvironment("DIV3RSA_BROWSER_EXECUTOR_PORT", 7320);
const browser: Browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  chromiumSandbox: true,
  proxy: { server: proxyUrl }
});
const sessions = new Map<string, Session>();

async function closeSession(runId: string): Promise<void> {
  const session = sessions.get(runId);
  if (!session) return;
  sessions.delete(runId);
  await session.context.close().catch(() => {});
}

async function scopedRoute(route: Route, scope: BrowserScope): Promise<void> {
  const url = route.request().url();
  try {
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return void await route.continue();
    await assertBrowserUrlAllowed(url, scope);
    await route.continue();
  } catch {
    await route.abort("blockedbyclient");
  }
}

async function createSession(input: BrowserExecutorRequest): Promise<Session> {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0]?.[0];
    if (oldest) await closeSession(oldest);
  }
  const context = await browser.newContext({
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    serviceWorkers: "block"
  });
  await context.route("**/*", (route) => scopedRoute(route, input.scope));
  const page = await context.newPage();
  const session = { context, page, scopeKey: scopeFingerprint(input.scope), lastUsedAt: Date.now() };
  sessions.set(input.runId, session);
  return session;
}

async function sessionFor(input: BrowserExecutorRequest): Promise<Session> {
  const key = scopeFingerprint(input.scope);
  const existing = sessions.get(input.runId);
  if (existing) {
    if (existing.scopeKey !== key) {
      await closeSession(input.runId);
      throw new Error("browser_scope_changed");
    }
    existing.lastUsedAt = Date.now();
    const newest = existing.context.pages().at(-1);
    if (newest) existing.page = newest;
    return existing;
  }
  return createSession(input);
}

async function execute(input: BrowserExecutorRequest): Promise<Record<string, unknown>> {
  validateRequest(input);
  const session = await sessionFor(input);
  const page = session.page;
  page.setDefaultTimeout(input.timeoutMs);
  page.setDefaultNavigationTimeout(input.timeoutMs);

  switch (input.action) {
    case "browser_navigate": {
      const url = boundedString(input.input.url, "url", 2048);
      await assertBrowserUrlAllowed(url, input.scope);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      return { ok: true, action: input.action, url: page.url(), title: await page.title() };
    }
    case "browser_read": {
      const text = (await page.locator("body").innerText({ timeout: input.timeoutMs })).slice(0, MAX_TEXT_CHARS);
      return { ok: true, action: input.action, url: page.url(), title: await page.title(), text, truncated: text.length >= MAX_TEXT_CHARS };
    }
    case "browser_click": {
      const selector = boundedString(input.input.selector, "selector", 1000);
      await page.locator(selector).click({ timeout: input.timeoutMs });
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(input.timeoutMs, 5_000) }).catch(() => {});
      const newest = session.context.pages().at(-1);
      if (newest) session.page = newest;
      return { ok: true, action: input.action, url: session.page.url(), title: await session.page.title() };
    }
    case "browser_type": {
      const selector = boundedString(input.input.selector, "selector", 1000);
      const text = boundedString(input.input.text, "text", 8_000);
      await page.locator(selector).fill(text, { timeout: input.timeoutMs });
      return { ok: true, action: input.action, url: page.url() };
    }
    case "browser_screenshot": {
      const screenshot = await page.screenshot({ type: "png", fullPage: false });
      if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("browser_screenshot_too_large");
      return { ok: true, action: input.action, url: page.url(), mimeType: "image/png", base64: screenshot.toString("base64") };
    }
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { ok: browser.isConnected(), service: "browser-executor", sessions: sessions.size, proxy: true });
    }
    if (request.method !== "POST" || request.url !== "/v1/execute") return json(response, 404, { error: "not_found" });
    if (!bearerMatches(request.headers.authorization, token)) return json(response, 401, { error: "unauthorized" });
    const input = await readJson(request);
    const result = await execute(input);
    return json(response, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "browser_executor_failed";
    return json(response, /scope|target|action|invalid|required|blocked|port|protocol/.test(message) ? 400 : 500, { error: message.slice(0, 180) });
  }
});

const cleanup = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [runId, session] of sessions) if (session.lastUsedAt < cutoff) void closeSession(runId);
}, 30_000);
cleanup.unref?.();

server.requestTimeout = 65_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.listen(listenPort, listenHost, () => console.info(`[browser-executor] listening host=${listenHost} port=${listenPort}`));

async function stop() {
  clearInterval(cleanup);
  server.close();
  await Promise.all([...sessions.keys()].map(closeSession));
  await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
