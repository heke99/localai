import type { ProviderToolExecutor } from "./integration-tool-runtime";

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export class RemoteProviderToolExecutor implements ProviderToolExecutor {
  constructor(private readonly gatewayUrl: string) {}

  async execute({ authorization, tool, arguments: input, context }: Parameters<ProviderToolExecutor["execute"]>[0]): Promise<unknown> {
    const response = await fetch(this.gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(context?.operationId ? { "Idempotency-Key": context.operationId } : {})
      },
      body: JSON.stringify({
        grantId: authorization.executionGrantId,
        toolName: tool.name,
        args: input,
        operationId: context?.operationId ?? null,
        attempt: context?.attempt ?? 1
      }),
      signal: combinedSignal(context?.signal, 120_000)
    });
    const body = await response.json().catch(() => null) as { result?: unknown; error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? `integration_gateway_${response.status}`);
    if (!body || !("result" in body)) throw new Error("integration_gateway_response_invalid");
    return body.result;
  }
}
