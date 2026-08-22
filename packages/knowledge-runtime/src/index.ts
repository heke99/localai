import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type SourceType = "text" | "file" | "url" | "repository";
export interface SourceInput { id: string; tenantId: string; type: SourceType; content: string; uri: string; acquiredAt: string; version?: string; license?: string }
export interface KnowledgeChunk { id: string; tenantId: string; content: string; contentHash: string; tokens: string[]; citation: { sourceId: string; uri: string; start: number; end: number; acquiredAt: string } }
export interface IngestionResult { sourceHash: string; status: "candidate" | "quarantined"; findings: string[]; chunks: KnowledgeChunk[] }

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenize = (value: string) => [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];

export function ingestSource(source: SourceInput, options: { chunkChars?: number } = {}): IngestionResult {
  if (!source.id || !source.tenantId || !source.uri || !source.content.trim()) throw new Error("invalid_knowledge_source");
  const findings: string[] = [];
  if (/(?:sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,}|sb_secret_|BEGIN (?:RSA |EC )?PRIVATE KEY)/i.test(source.content)) findings.push("secret_pattern");
  if (/(?:ignore|disregard) (?:all |any )?(?:previous|prior|system) instructions|reveal (?:the )?(?:system prompt|secrets)|developer message/i.test(source.content)) findings.push("prompt_injection_pattern");
  if (source.type === "file" && /\.(?:exe|dll|so|dylib|jar|docm|xlsm)$/i.test(source.uri)) findings.push("executable_content");
  const size = Math.max(256, Math.min(options.chunkChars ?? 1800, 8000));
  const content = source.content.replace(/\r\n/g, "\n").trim();
  const chunks: KnowledgeChunk[] = [];
  for (let start = 0, index = 0; start < content.length; index += 1) {
    let end = Math.min(start + size, content.length);
    if (end < content.length) {
      const boundary = content.lastIndexOf("\n", end);
      if (boundary > start + size / 2) end = boundary;
    }
    const value = content.slice(start, end).trim();
    if (value) chunks.push({ id: `${source.id}:${index}`, tenantId: source.tenantId, content: value, contentHash: sha256(value), tokens: tokenize(value), citation: { sourceId: source.id, uri: source.uri, start, end, acquiredAt: source.acquiredAt } });
    start = end === start ? start + size : end;
  }
  return { sourceHash: sha256(content), status: findings.length ? "quarantined" : "candidate", findings, chunks };
}

const privateIp = (ip: string) => ip === "::1" || ip === "::" || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
export async function ingestUrl(source: Omit<SourceInput, "type" | "content">, dependencies: { fetcher?: typeof fetch; resolveHost: (host: string) => Promise<string[]>; maximumBytes?: number }): Promise<IngestionResult> {
  const url = new URL(source.uri);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw new Error("knowledge_url_https_required");
  const addresses = await dependencies.resolveHost(url.hostname);
  if (!addresses.length || addresses.some((address) => !isIP(address) || privateIp(address))) throw new Error("knowledge_url_private_network");
  const maximumBytes = dependencies.maximumBytes ?? 2_000_000;
  const response = await (dependencies.fetcher ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Accept: "text/plain,text/html,application/json,application/pdf;q=0" } });
  if (!response.ok) throw new Error(`knowledge_url_fetch_failed:${response.status}`);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!/^(?:text\/plain|text\/html|application\/json)/.test(contentType)) throw new Error("knowledge_url_content_type_rejected");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maximumBytes) throw new Error("knowledge_url_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error("knowledge_url_too_large");
  let content = new TextDecoder().decode(bytes);
  if (contentType.startsWith("text/html")) content = content.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return ingestSource({ ...source, type: "url", content });
}

export function retrieveHybrid(query: string, chunks: KnowledgeChunk[], options: { tenantId: string; limit: number; vectorScores?: ReadonlyMap<string, number> }): Array<KnowledgeChunk & { score: number }> {
  const queryTokens = tokenize(query);
  return chunks
    .filter((chunk) => chunk.tenantId === options.tenantId)
    .map((chunk) => {
      const overlap = queryTokens.filter((token) => chunk.tokens.includes(token)).length;
      const lexical = queryTokens.length ? overlap / queryTokens.length : 0;
      const vector = options.vectorScores?.get(chunk.id) ?? 0;
      return { ...chunk, score: lexical * 0.65 + vector * 0.35 };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, options.limit));
}
