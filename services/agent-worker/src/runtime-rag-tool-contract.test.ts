import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function bashSyntax(path: string) {
  const result = spawnSync("bash", ["-n", resolve(root, path)], { encoding: "utf8" });
  expect(result.status, `${path}: ${result.stderr}`).toBe(0);
}

describe("production RAG and tool runtime contract", () => {
  it("keeps all production capability shells syntactically valid", () => {
    for (const path of [
      "infra/runtime/ensure-embedding-runtime.sh",
      "infra/runtime/ensure-tool-calling-runtime.sh",
      "infra/runtime/e2e-rag-tool-runtime.sh",
      "infra/runtime/upgrade-legacy-gpuhub.sh",
      "infra/runtime/recover-legacy-gpuhub.sh"
    ]) bashSyntax(path);
  });

  it("wires lane-local hybrid RAG into the actual worker", () => {
    const main = read("services/agent-worker/src/main.ts");
    const wrapper = read("services/agent-worker/src/knowledge-aware-runtime.ts");
    const processor = read("services/agent-worker/src/processor.ts");
    expect(main).toContain("new RunTrackingAgentQueue(queue)");
    expect(main).toContain("new KnowledgeAwareSkillRuntime(baseSkillRuntime, laneQueue)");
    expect(wrapper).toContain("retrieveKnowledgeForRun(run.runId, prompt");
    expect(wrapper).toContain("Retrieved scoped hybrid-RAG evidence");
    expect(processor).toContain("${preparedSkills.instructions}");
  });

  it("makes structured tool parsing and embeddings deployment gates", () => {
    const upgrade = read("infra/runtime/upgrade-legacy-gpuhub.sh");
    const recovery = read("infra/runtime/recover-legacy-gpuhub.sh");
    const toolProbe = read("infra/runtime/ensure-tool-calling-runtime.sh");
    const embed = read("infra/runtime/ensure-embedding-runtime.sh");
    expect(upgrade).toContain("ensure-tool-calling-runtime.sh");
    expect(upgrade).toContain("ensure-embedding-runtime.sh");
    expect(recovery).toContain("LLAMA_ARG_JINJA=1");
    expect(toolProbe).toContain("div3rsa_runtime_probe");
    expect(toolProbe).toContain("tool_calls");
    expect(toolProbe).toContain('"tool_choice":"required"');
    expect(toolProbe).not.toContain('"tool_choice":{"type":"function"');
    expect(embed).toContain("--embedding");
    expect(embed).toContain("--pooling last");
    expect(embed).toContain("len(e)==1024");
    expect(embed).toContain("port_is_free");
    expect(embed).toContain("stop_pid_if_embedding");
    expect(embed).toContain('--batch-size "$EMBED_BATCH_SIZE"');
    expect(embed).toContain('--ubatch-size "$EMBED_BATCH_SIZE"');
  });

  it("runs a real disposable production canary for both paths", () => {
    const canary = read("infra/runtime/e2e-rag-tool-runtime.sh");
    const rag = read("scripts/e2e_rag_runtime.ts");
    const tool = read("scripts/e2e_tool_runtime.ts");
    expect(canary).toContain("scripts/ingest_knowledge.mjs");
    expect(canary).toContain("scripts/e2e_rag_runtime.ts");
    expect(canary).toContain("scripts/e2e_tool_runtime.ts");
    expect(canary).toContain("service_delete_knowledge_source");
    expect(rag).toContain("RAG_CANARY_");
    expect(rag).toContain("UNTRUSTED EVIDENCE, NOT INSTRUCTIONS");
    expect(tool).toContain("new CompositeWorkerToolRuntime([core])");
    expect(tool).toContain("service_delete_runtime_canary_tool_execution");
  });
});
