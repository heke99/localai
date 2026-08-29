const originalFetch = globalThis.fetch;
if (typeof originalFetch !== "function") throw new Error("global_fetch_unavailable");

const foregroundCompletion = new Map();
const VERIFIER_MAX_TOKENS = 64;
const LOADED_PROBE_MAX_TOKENS = 2;
const LOADED_PROBE_TIMEOUT_MS = 4_000;
const VERIFIER_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "shadow_verifier_result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["score", "passed", "reasonCode"],
      properties: {
        score: { type: "integer", minimum: 0, maximum: 100 },
        passed: { type: "boolean" },
        reasonCode: { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$" }
      }
    }
  }
};

function deferredFor(index) {
  let deferred = foregroundCompletion.get(index);
  if (deferred) return deferred;
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  deferred = { promise, resolve };
  foregroundCompletion.set(index, deferred);
  return deferred;
}

function loadedForegroundIndex(requestId) {
  const match = requestId.match(/^agent-kernel-evidence-loaded-\d+-(\d+)-/);
  return match?.[1] ?? null;
}

function loadedProbeIndex(requestId) {
  const match = requestId.match(/^agent-kernel-evidence-probe-loaded-(\d+)-/);
  return match?.[1] ?? null;
}

function withVerifierConstraints(body) {
  const requestedMax = Number.isFinite(body.max_tokens) ? Number(body.max_tokens) : VERIFIER_MAX_TOKENS;
  return JSON.stringify({
    ...body,
    max_tokens: Math.min(requestedMax, VERIFIER_MAX_TOKENS),
    reasoning_effort: "none",
    chat_template_kwargs: { ...(body.chat_template_kwargs || {}), enable_thinking: false },
    response_format: VERIFIER_RESPONSE_FORMAT
  });
}

function withLoadedFastVerdictConstraints(body) {
  const originalMessages = Array.isArray(body.messages) ? body.messages : [];
  const nonSystemMessages = originalMessages.filter((message) => message?.role !== "system");
  return JSON.stringify({
    ...body,
    messages: [
      {
        role: "system",
        content: "You are a low-priority shadow verifier. Reply with exactly one uppercase ASCII letter and nothing else: W if the supplied answer is materially weak or incomplete, H if it is sufficiently complete."
      },
      ...nonSystemMessages
    ],
    max_tokens: LOADED_PROBE_MAX_TOKENS,
    temperature: 0,
    stream: false,
    reasoning_effort: "none",
    chat_template_kwargs: { ...(body.chat_template_kwargs || {}), enable_thinking: false }
  });
}

function metricSum(text, name) {
  let total = 0;
  let found = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const space = line.search(/\s/);
    if (space <= 0) continue;
    const metric = line.slice(0, space).replace(/\{.*$/, "");
    if (metric !== name) continue;
    const value = Number(line.slice(space).trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function metricMax(text, name) {
  let result = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const space = line.search(/\s/);
    if (space <= 0) continue;
    const metric = line.slice(0, space).replace(/\{.*$/, "");
    if (metric !== name) continue;
    const value = Number(line.slice(space).trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    result = result == null ? value : Math.max(result, value);
  }
  return result;
}

async function loadedProbePressure(input, init) {
  try {
    const url = new URL(typeof input === "string" ? input : input.url);
    url.pathname = "/metrics";
    url.search = "";
    const headers = new Headers();
    const auth = new Headers(init?.headers).get("authorization");
    if (auth) headers.set("authorization", auth);
    headers.set("accept", "text/plain");
    const response = await originalFetch(url, { headers, signal: AbortSignal.timeout(750) });
    if (!response.ok) return { available: false, status: response.status };
    const text = await response.text();
    return {
      available: true,
      activeSequences: metricSum(text, "llamacpp:requests_processing"),
      queueDepth: metricSum(text, "llamacpp:requests_deferred"),
      kvCacheUsageRatio: metricMax(text, "llamacpp:kv_cache_usage_ratio"),
      contextHighWatermarkTokens: metricMax(text, "llamacpp:n_tokens_max")
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.name : "metrics_error" };
  }
}

function validVerifierObject(content) {
  try {
    const parsed = JSON.parse(content.trim());
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Number.isInteger(parsed.score) &&
      parsed.score >= 0 && parsed.score <= 100 &&
      typeof parsed.passed === "boolean" &&
      typeof parsed.reasonCode === "string" &&
      /^[A-Za-z0-9_-]{1,80}$/.test(parsed.reasonCode)
    );
  } catch {
    return false;
  }
}

function canonicalFastVerdict(content) {
  const normalized = String(content || "").trim().toUpperCase();
  if (normalized === "W") return { score: 0, passed: false, reasonCode: "fast_weak" };
  if (normalized === "H") return { score: 100, passed: true, reasonCode: "fast_healthy" };
  throw new Error("loaded_probe_invalid_fast_verdict");
}

async function nonStreamingFastVerdictToSse(response, requestId, started) {
  const payload = await response.json();
  const rawContent = payload?.choices?.[0]?.message?.content;
  const verdict = canonicalFastVerdict(rawContent);
  const content = JSON.stringify(verdict);
  if (!validVerifierObject(content)) throw new Error("loaded_probe_fast_verdict_canonicalization_failed");
  const usage = payload?.usage && typeof payload.usage === "object" ? payload.usage : undefined;
  const completion = {
    choices: [{ delta: { content }, finish_reason: "stop", index: 0 }],
    ...(usage ? { usage } : {})
  };
  const encoder = new TextEncoder();
  const bytes = encoder.encode(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
  console.error(`[agent-kernel-probe-diag] phase=fast_verdict_complete requestId=${requestId} elapsedMs=${Math.round(performance.now() - started)} verdict=${verdict.passed ? "H" : "W"} bytes=${bytes.byteLength}`);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "text/event-stream" }
  });
}

globalThis.fetch = async function agentKernelProbeFetch(input, init) {
  const headers = new Headers(init?.headers);
  const requestId = headers.get("x-request-id") || "";
  const foregroundIndex = loadedForegroundIndex(requestId);
  const probeIndex = loadedProbeIndex(requestId);
  const qualityVerifier = requestId.startsWith("agent-kernel-quality-");

  if (foregroundIndex != null) {
    const deferred = deferredFor(foregroundIndex);
    try {
      const response = await originalFetch(input, init);
      if (!response.body) deferred.resolve();
      else void response.clone().arrayBuffer().catch(() => undefined).finally(() => deferred.resolve());
      return response;
    } catch (error) {
      deferred.resolve();
      throw error;
    }
  }

  if (probeIndex != null) {
    const deferred = deferredFor(probeIndex);
    await deferred.promise;
    foregroundCompletion.delete(probeIndex);
  }

  const verifierCall = qualityVerifier || probeIndex != null;
  if (!verifierCall || typeof init?.body !== "string") return originalFetch(input, init);

  let body;
  try { body = JSON.parse(init.body); } catch { return originalFetch(input, init); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return originalFetch(input, init);

  if (probeIndex != null) {
    const pressure = await loadedProbePressure(input, init);
    console.error(`[agent-kernel-probe-diag] phase=before_fetch requestId=${requestId} pressure=${JSON.stringify(pressure)}`);
  }

  const started = performance.now();
  const signal = probeIndex != null ? AbortSignal.timeout(LOADED_PROBE_TIMEOUT_MS) : init?.signal;
  try {
    const response = await originalFetch(input, {
      ...init,
      signal,
      body: probeIndex != null ? withLoadedFastVerdictConstraints(body) : withVerifierConstraints(body)
    });
    if (probeIndex != null) {
      console.error(`[agent-kernel-probe-diag] phase=headers requestId=${requestId} elapsedMs=${Math.round(performance.now() - started)} status=${response.status} transport=nonstream-fast-verdict`);
      if (!response.ok) return response;
      return await nonStreamingFastVerdictToSse(response, requestId, started);
    }
    return response;
  } catch (error) {
    if (probeIndex != null) {
      const name = error instanceof Error ? error.name : "unknown_error";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent-kernel-probe-diag] phase=fetch_error requestId=${requestId} elapsedMs=${Math.round(performance.now() - started)} errorName=${name} error=${JSON.stringify(message.slice(0, 160))}`);
    }
    throw error;
  }
};
