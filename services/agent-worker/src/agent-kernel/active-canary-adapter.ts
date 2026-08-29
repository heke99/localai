import { processPrompt, type AgentMode } from "@div3rsa/agent-runtime";
import type { GenerateRequest, GenerateResult, ModelAdapter, ModelCapability, ModelHealth, ModelStreamDeltaHandler } from "@div3rsa/model-sdk";
import type { AgentKernelConfig } from "./config";
import { AgentKernelActiveCanaryRuntime, type ActiveCanaryAugmentation } from "./active-canary";

function primaryRequest(request: GenerateRequest): { runKey: string; mode: AgentMode; prompt: string; selectedSkills: string[] } | null {
  const system = request.messages.find((message) => message.role === "system")?.content ?? "";
  if (!system.includes("Execution contract:") || !system.includes("Reasoning policy:")) return null;
  const modeMatch = system.match(/Mode:\s*(chat|code|lab|research)\./i);
  if (!modeMatch) return null;
  const prompt = request.messages.find((message) => message.role === "user")?.content?.trim() ?? "";
  if (!prompt) return null;
  const skillMatch = system.match(/Active skills:\s*([^.]*)\./i);
  const selectedSkills = (skillMatch?.[1] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const runKey = request.requestId.replace(/:\d+:\d+$/, "");
  return { runKey, mode: modeMatch[1]!.toLowerCase() as AgentMode, prompt, selectedSkills };
}

function inject(request: GenerateRequest, augmentation: ActiveCanaryAugmentation): GenerateRequest {
  let injected = false;
  const messages = request.messages.map((message) => {
    if (injected || message.role !== "system") return message;
    injected = true;
    return {
      ...message,
      content: `${message.content}\n\n${augmentation.instruction}\n\nThe normal execution contract, actual tool evidence and independent verification remain authoritative.`
    };
  });
  return { ...request, messages };
}

export class AgentKernelActiveCanaryAdapter implements ModelAdapter {
  private readonly runtime: AgentKernelActiveCanaryRuntime;
  private readonly cache = new Map<string, ActiveCanaryAugmentation | null>();

  constructor(
    private readonly inner: ModelAdapter,
    config: AgentKernelConfig,
    private readonly maxCachedRuns = 512
  ) {
    this.runtime = new AgentKernelActiveCanaryRuntime(config, {
      generate: async (input) => this.inner.generate({
        requestId: input.requestId,
        alias: input.alias,
        messages: input.messages,
        temperature: input.temperature,
        maxOutputTokens: input.maxOutputTokens,
        signal: input.signal,
        disableThinking: true
      })
    });
  }

  getCapabilities(): ReadonlySet<ModelCapability> { return this.inner.getCapabilities(); }
  estimateTokens(text: string): Promise<number> { return this.inner.estimateTokens(text); }
  healthCheck(): Promise<ModelHealth> { return this.inner.healthCheck(); }

  private async augmented(request: GenerateRequest): Promise<GenerateRequest> {
    const primary = primaryRequest(request);
    if (!primary) return request;
    let augmentation = this.cache.get(primary.runKey);
    if (augmentation === undefined) {
      try {
        const contract = processPrompt(primary.mode, primary.prompt, {});
        augmentation = await this.runtime.prepare({
          runId: primary.runKey,
          requestId: request.requestId,
          modelAlias: request.alias,
          prompt: primary.prompt,
          task: contract.analysis,
          selectedSkills: primary.selectedSkills
        });
      } catch {
        augmentation = null;
      }
      this.cache.set(primary.runKey, augmentation);
      while (this.cache.size > this.maxCachedRuns) this.cache.delete(this.cache.keys().next().value!);
    }
    return augmentation ? inject(request, augmentation) : request;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return this.inner.generate(await this.augmented(request));
  }

  async generateStreamed(request: GenerateRequest, onDelta: ModelStreamDeltaHandler): Promise<GenerateResult> {
    const augmented = await this.augmented(request);
    if (this.inner.generateStreamed) return this.inner.generateStreamed(augmented, onDelta);
    const result = await this.inner.generate(augmented);
    if (result.content) await onDelta(result.content);
    return result;
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const augmented = await this.augmented(request);
    yield* this.inner.stream(augmented);
  }
}
