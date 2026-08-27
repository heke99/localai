import { describe, expect, it, vi } from "vitest";
import type { ClaimedRun } from "./processor";
import { CoreToolRuntime } from "./core-tool-runtime";

const run: ClaimedRun = {
  jobId: "job",
  runId: "run",
  mode: "chat",
  modelAlias: "general-prod",
  prompt: "test",
  requestId: "request",
  traceId: "trace",
  resourceContext: []
};

describe("CoreToolRuntime", () => {
  it("returns the real injected instant in an IANA timezone with DST-aware offset", async () => {
    const runtime = new CoreToolRuntime({ now: () => new Date("2026-08-27T09:40:00.000Z") });
    const result = await runtime.execute(run, { id: "time", name: "current_time", input: { timezone: "Europe/Stockholm" } }) as Record<string, unknown>;
    expect(result).toMatchObject({
      timezone: "Europe/Stockholm",
      localDate: "2026-08-27",
      localTime: "11:40:00",
      utcOffset: "+02:00",
      epochMs: 1787823600000
    });
  });

  it("exposes search only when a search service is configured", async () => {
    const withoutSearch = new CoreToolRuntime();
    expect((await withoutSearch.list(run)).map((tool) => tool.name)).toEqual(["current_time", "convert_time", "web_fetch"]);

    const withSearch = new CoreToolRuntime({ searchBaseUrl: "http://search.internal:8080" });
    expect((await withSearch.list(run)).map((tool) => tool.name)).toEqual(["current_time", "convert_time", "web_search", "web_fetch"]);
  });

  it("queries a SearXNG-compatible service and normalizes results", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://search.internal:8080");
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("Skatteverket regler 2026");
      expect(url.searchParams.get("format")).toBe("json");
      expect(url.searchParams.get("language")).toBe("sv-SE");
      return new Response(JSON.stringify({
        results: [
          { title: "Skatteverket", url: "https://www.skatteverket.se/a", content: "Aktuell regel", engine: "bing", score: 4.2, publishedDate: "2026-08-20" },
          { title: "Secondary", url: "https://example.com/b", content: "Blogg", engine: "duckduckgo", score: 1.1 }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const runtime = new CoreToolRuntime({ searchBaseUrl: "http://search.internal:8080", fetcher: fetcher as typeof fetch });
    const result = await runtime.execute(run, { id: "search", name: "web_search", input: { query: "Skatteverket regler 2026", language: "sv-SE", limit: 5 } }) as { results: Array<Record<string, unknown>> };
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ title: "Skatteverket", url: "https://www.skatteverket.se/a", snippet: "Aktuell regel", engine: "bing", publishedAt: "2026-08-20" });
  });

  it("blocks localhost and private targets before web fetch", async () => {
    const fetcher = vi.fn();
    const runtime = new CoreToolRuntime({ fetcher: fetcher as typeof fetch, resolveHost: async () => ["127.0.0.1"] });
    await expect(runtime.execute(run, { id: "fetch", name: "web_fetch", input: { url: "http://localhost:8080/admin" } })).rejects.toThrow("web_fetch_target_blocked");
    await expect(runtime.execute(run, { id: "fetch2", name: "web_fetch", input: { url: "https://private.example/" } })).rejects.toThrow("web_fetch_target_blocked");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches public text, strips active HTML and revalidates redirect targets", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://www.example.com/article" } }))
      .mockResolvedValueOnce(new Response("<html><head><title>Example</title><script>steal()</script></head><body><h1>Hello</h1><p>Useful &amp; current.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      }));
    const runtime = new CoreToolRuntime({
      fetcher: fetcher as typeof fetch,
      resolveHost: async (hostname) => hostname === "example.com" || hostname === "www.example.com" ? ["93.184.216.34"] : []
    });
    const result = await runtime.execute(run, { id: "fetch", name: "web_fetch", input: { url: "https://example.com/start" } }) as Record<string, unknown>;
    expect(result).toMatchObject({ url: "https://www.example.com/article", title: "Example", contentType: "text/html" });
    const normalized = String(result.text).replace(/\s+/g, " ").trim();
    expect(normalized).toContain("Hello Useful & current.");
    expect(normalized).not.toContain("steal");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses redirects into private address space", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/secrets" } }));
    const runtime = new CoreToolRuntime({ fetcher: fetcher as typeof fetch, resolveHost: async () => ["93.184.216.34"] });
    await expect(runtime.execute(run, { id: "fetch", name: "web_fetch", input: { url: "https://example.com/start" } })).rejects.toThrow("web_fetch_target_blocked");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
