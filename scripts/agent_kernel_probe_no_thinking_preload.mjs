const originalFetch = globalThis.fetch;
if (typeof originalFetch !== "function") throw new Error("global_fetch_unavailable");

globalThis.fetch = async function agentKernelProbeFetch(input, init) {
  const headers = new Headers(init?.headers);
  const requestId = headers.get("x-request-id") || "";
  const verifierCall = requestId.startsWith("agent-kernel-quality-") || requestId.startsWith("agent-kernel-evidence-probe-");
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
    body: JSON.stringify({
      ...body,
      reasoning_effort: "none",
      chat_template_kwargs: { ...(body.chat_template_kwargs || {}), enable_thinking: false }
    })
  });
};
