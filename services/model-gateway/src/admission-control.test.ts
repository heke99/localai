import { describe, expect, it, vi } from "vitest";
import type { AdmissionController, AdmissionSnapshot } from "./admission-control";
import { LlamaCppAdmissionController, ModelAdmissionRejectedError, ModelAdmissionTimeoutError } from "./admission-control";
import { OpenAiCompatibleAdapter } from "./openai-compatible-adapter";

const admittedSnapshot: AdmissionSnapshot = {
  activeSequences: 0,
  queueDepth: 0,
  kvCacheUsageRatio: 0,
  tokensPerSecond: 30,
  ttftMs: 200,
  interTokenLatencyMs: 25,
  gpuUtilizationRatio: 0.4,
  vramUsageRatio: 0.5,
  requestContextTokens: 1024,
  contextHighWatermarkTokens: 1024,
  contextLimit: 32768,
  batchSize: 2048,
  telemetryAvailable: true
};

describe("LlamaCppAdmissionController", () => {
  it("combines llama.cpp, request timing and DCGM pressure into one snapshot", async () => {
    const llamaMetrics = [
      "llamacpp:requests_processing 1",
      "llamacpp:requests_deferred 0",
      "llamacpp:kv_cache_usage_ratio 0.42",
      "llamacpp:tokens_predicted_total 600",
      "llamacpp:predicted_tokens_seconds 20",
      "llamacpp:n_tokens_max 4096"
    ].join("\n");
    const gpuMetrics = [
      'DCGM_FI_DEV_GPU_UTIL{gpu="0"} 71',
      'DCGM_FI_DEV_FB_USED{gpu="0"} 48000',
      'DCGM_FI_DEV_FB_FREE{gpu="0"} 48000'
    ].join("\n");
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(String(input).includes("gpu-metrics") ? gpuMetrics : llamaMetrics, { status: 200 }));
    const controller = new LlamaCppAdmissionController("http://model:8080/v1", "secret", {
      gpuMetricsUrl: "http://gpu-metrics:9400/metrics",
      maxActiveSequences: 4
    }, fetcher as typeof fetch);
    controller.observeTimings({ tokensPerSecond: 28, ttftMs: 450, interTokenLatencyMs: 36 });

    const snapshot = await controller.snapshot(8192);
    expect(snapshot).toMatchObject({
      activeSequences: 1,
      queueDepth: 0,
      kvCacheUsageRatio: 0.42,
      tokensPerSecond: 28,
      ttftMs: 450,
      interTokenLatencyMs: 36,
      gpuUtilizationRatio: 0.71,
      vramUsageRatio: 0.5,
      requestContextTokens: 8192,
      contextHighWatermarkTokens: 4096,
      contextLimit: 32768,
      batchSize: 2048,
      telemetryAvailable: true
    });
    expect(controller.assess(snapshot).action).toBe("admit");
    expect(fetcher).toHaveBeenCalledWith("http://model:8080/metrics", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer secret" }) }));
  });

  it("defers overloaded inference instead of piling more work into llama.cpp", async () => {
    const fetcher = vi.fn(async () => new Response("llamacpp:requests_processing 4\nllamacpp:requests_deferred 2\n", { status: 200 }));
    const controller = new LlamaCppAdmissionController("http://model:8080/v1", "secret", {
      maxActiveSequences: 4,
      maxWaitMs: 0
    }, fetcher as typeof fetch);

    await expect(controller.waitForAdmission(1024)).rejects.toBeInstanceOf(ModelAdmissionTimeoutError);
  });

  it("aborts while waiting for overloaded capacity", async () => {
    const fetcher = vi.fn(async () => new Response("llamacpp:requests_processing 4\n", { status: 200 }));
    const controller = new LlamaCppAdmissionController("http://model:8080/v1", "secret", {
      maxActiveSequences: 4,
      pollIntervalMs: 5_000,
      maxWaitMs: 30_000
    }, fetcher as typeof fetch);
    const abort = new AbortController();
    const pending = controller.waitForAdmission(1024, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects requests that cannot fit in the configured context window", async () => {
    const fetcher = vi.fn(async () => new Response("llamacpp:requests_processing 0\n", { status: 200 }));
    const controller = new LlamaCppAdmissionController("http://model:8080/v1", "secret", { contextLimit: 4096 }, fetcher as typeof fetch);

    await expect(controller.waitForAdmission(4097)).rejects.toBeInstanceOf(ModelAdmissionRejectedError);
  });

  it("fails open on telemetry outage while preserving the hard context limit", async () => {
    const fetcher = vi.fn(async () => { throw new Error("metrics unavailable"); });
    const controller = new LlamaCppAdmissionController("http://model:8080/v1", "secret", {}, fetcher as typeof fetch);

    const snapshot = await controller.waitForAdmission(2048);
    expect(snapshot.telemetryAvailable).toBe(false);
    expect(controller.assess(snapshot)).toMatchObject({ action: "admit", reason: "telemetry_unavailable" });
  });
});

describe("OpenAiCompatibleAdapter admission integration", () => {
  it("gates generation and feeds llama.cpp timings back into admission control", async () => {
    const admission: AdmissionController = {
      waitForAdmission: vi.fn(async () => admittedSnapshot),
      observeTimings: vi.fn()
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
      timings: { prompt_ms: 320, predicted_n: 2, predicted_ms: 80, predicted_per_second: 25 }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new OpenAiCompatibleAdapter("http://model:8080/v1", "secret", fetcher as typeof fetch, admission);

    await adapter.generate({ requestId: "req-admission", alias: "general-prod", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 128 });

    expect(admission.waitForAdmission).toHaveBeenCalledOnce();
    expect(admission.waitForAdmission).toHaveBeenCalledWith(expect.any(Number), undefined);
    expect(admission.observeTimings).toHaveBeenCalledWith({ ttftMs: 320, tokensPerSecond: 25, interTokenLatencyMs: 40 });
  });
});
