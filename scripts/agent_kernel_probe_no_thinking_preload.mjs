const originalFetch = globalThis.fetch;
if (typeof originalFetch !== "function") throw new Error("global_fetch_unavailable");

const foregroundCompletion = new Map();

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

function withThinkingDisabled(body) {
  return JSON.stringify({
    ...body,
    reasoning_effort: "none",
    chat_template_kwargs: { ...(body.chat_template_kwargs || {}), enable_thinking: false }
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
      if (!response.body) {
        deferred.resolve();
      } else {
        void response.clone().arrayBuffer().catch(() => undefined).finally(() => deferred.resolve());
      }
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
  try {
    body = JSON.parse(init.body);
  } catch {
    return originalFetch(input, init);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return originalFetch(input, init);

  return originalFetch(input, {
    ...init,
    body: withThinkingDisabled(body)
  });
};
