import type { ProviderToolExecutor } from "./integration-tool-runtime";
import { linkedAbortController, throwIfAborted } from "./tool-execution-context";

export class RemoteProviderToolExecutor implements ProviderToolExecutor {
  constructor(private readonly gatewayUrl: string) {}

  async execute({ authorization, tool, arguments: input, context }: Parameters<ProviderToolExecutor["execute"]>[0]): Promise<unknown> {
    throwIfAborted(context?.signal);
    const linked = linkedAbortController(context?.signal, 120_000, "integration_gateway_timeout");
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json"
      };
      if (context?.operationId) headers["Idempotency-Key"] = context.operationId;
      if (context?.executionId) headers["X-Tool-Execution-Id"] = context.executionId;
      const response = await fetch(this.gatewayUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          grantId: authorization.executionGrantId,
          toolName: tool.name,
          args: input,
          operationId: context?.operationId ?? null,
          attempt: context?.attempt ?? 1
        }),
        signal: linked.controller.signal
      });
      const body = await response.json().catch(() => null) as { result?: unknown; error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `integration_gateway_${response.status}`);
      if (!body || !("result" in body)) throw new Error("integration_gateway_response_invalid");
      return body.result;
    } finally {
      linked.dispose();
    }
  }
}
