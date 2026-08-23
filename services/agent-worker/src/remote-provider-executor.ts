import type { ProviderToolExecutor } from "./integration-tool-runtime";

export class RemoteProviderToolExecutor implements ProviderToolExecutor {
  constructor(private readonly gatewayUrl: string) {}

  async execute({ authorization, tool, arguments: input }: Parameters<ProviderToolExecutor["execute"]>[0]): Promise<unknown> {
    const response = await fetch(this.gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grantId: authorization.executionGrantId, toolName: tool.name, args: input }),
      signal: AbortSignal.timeout(120_000)
    });
    const body = await response.json().catch(() => null) as { result?: unknown; error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? `integration_gateway_${response.status}`);
    if (!body || !("result" in body)) throw new Error("integration_gateway_response_invalid");
    return body.result;
  }
}
