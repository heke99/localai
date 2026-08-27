import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import type { ClaimedRun, WorkerToolRuntime } from "./processor";

export class CompositeWorkerToolRuntime implements WorkerToolRuntime {
  constructor(private readonly runtimes: readonly WorkerToolRuntime[]) {
    if (!runtimes.length) throw new Error("tool_runtime_required");
  }

  async list(run: ClaimedRun): Promise<ModelToolDefinition[]> {
    const definitions = (await Promise.all(this.runtimes.map((runtime) => runtime.list(run)))).flat();
    const names = new Set<string>();
    for (const definition of definitions) {
      if (names.has(definition.name)) throw new Error(`duplicate_tool_name:${definition.name}`);
      names.add(definition.name);
    }
    return definitions;
  }

  async execute(run: ClaimedRun, call: ModelToolCall): Promise<unknown> {
    for (const runtime of this.runtimes) {
      const definitions = await runtime.list(run);
      if (definitions.some((definition) => definition.name === call.name)) return runtime.execute(run, call);
    }
    throw new Error(`unknown_worker_tool:${call.name}`);
  }
}
