#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing_value:${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function required(value, name) {
  if (!value?.trim()) throw new Error(`missing_${name}`);
  return value.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function chunkText(text, maxChars = 1800, overlap = 240) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);
    if (end < normalized.length) {
      const candidates = [normalized.lastIndexOf("\n\n", end), normalized.lastIndexOf("\n", end), normalized.lastIndexOf(". ", end) + 1];
      const boundary = Math.max(...candidates.filter((candidate) => candidate > start + Math.floor(maxChars * 0.55)));
      if (Number.isFinite(boundary) && boundary > start) end = boundary;
    }
    const content = normalized.slice(start, end).trim();
    if (content) chunks.push(content);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

async function embed(content, baseUrl, apiKey, model) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: content, encoding_format: "float" }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`embedding_http_${response.status}:${JSON.stringify(body).slice(0,500)}`);
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1024 || vector.some((entry) => !Number.isFinite(Number(entry)))) throw new Error("embedding_dimension_invalid");
  return vector.map(Number);
}

async function rpc(name, args, supabaseUrl, serviceKey) {
  const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(60_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${name}_failed:${response.status}:${JSON.stringify(body).slice(0,1000)}`);
  return body;
}

const args = parseArgs(process.argv.slice(2));
const file = resolve(required(args.file, "file"));
const body = await readFile(file, "utf8");
const scopeType = args["scope-type"]?.trim() || "global";
const scopeId = args["scope-id"]?.trim() || null;
if (!["global","organization","workspace","project"].includes(scopeType)) throw new Error("invalid_scope_type");
if (scopeType === "global" && scopeId) throw new Error("global_scope_must_not_have_scope_id");
if (scopeType !== "global" && !scopeId) throw new Error("scope_id_required");

const sourceUri = args["source-uri"]?.trim() || `file://${file}`;
const title = args.title?.trim() || basename(file);
const sourceType = args["source-type"]?.trim() || "file";
const embeddingModel = process.env.DIV3RSA_EMBEDDING_MODEL?.trim() || "qwen3-embedding-0.6b-q8_0-d20cf9c";
const embeddingBaseUrl = process.env.DIV3RSA_EMBEDDING_BASE_URL?.trim() || "http://127.0.0.1:6007/v1";
const embeddingApiKey = required(process.env.DIV3RSA_EMBEDDING_API_KEY || process.env.DIV3RSA_INFERENCE_API_KEY || process.env.QWEN_INFERENCE_API_KEY, "embedding_api_key");
const supabaseUrl = required(process.env.SUPABASE_URL, "supabase_url");
const serviceKey = required(process.env.SUPABASE_SECRET_KEY, "supabase_secret_key");

const rawChunks = chunkText(body);
if (!rawChunks.length) throw new Error("knowledge_document_empty");
const chunks = [];
for (const content of rawChunks) {
  process.stderr.write(`Embedding chunk ${chunks.length + 1}/${rawChunks.length}\r`);
  chunks.push({
    content,
    tokenCount: Math.ceil(content.length / 4),
    contentHash: sha256(content),
    embedding: await embed(content, embeddingBaseUrl, embeddingApiKey, embeddingModel)
  });
}
process.stderr.write("\n");

const sourceId = await rpc("service_replace_knowledge_document", {
  target_scope_type: scopeType,
  target_scope_id: scopeId,
  target_source_type: sourceType,
  target_source_uri: sourceUri,
  target_content_hash: sha256(body),
  target_title: title,
  target_body: body,
  target_provenance: { ingestedBy: "scripts/ingest_knowledge.mjs", localFile: basename(file) },
  target_embedding_model: embeddingModel,
  target_chunks: chunks,
  target_valid_from: args["valid-from"] || null,
  target_valid_to: args["valid-to"] || null
}, supabaseUrl, serviceKey);

console.log(JSON.stringify({ ok: true, sourceId, chunks: chunks.length, embeddingModel, scopeType, scopeId, sourceUri }, null, 2));
