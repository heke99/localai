import { createHash } from "node:crypto";

export type KnowledgeScope = "user" | "workspace" | "project" | "global";
export interface KnowledgeCandidate {
  scope: KnowledgeScope;
  scopeId?: string;
  sourceType: "text" | "file" | "url" | "repository";
  sourceUri?: string;
  content: string;
  provenance: { submittedBy: string; capturedAt: string; license?: string };
  approvedBy?: string;
  approverIsSuperadmin?: boolean;
}

export interface PreparedKnowledge {
  contentHash: string;
  approvalStatus: "pending" | "approved";
  chunks: Array<{ index: number; content: string; contentHash: string }>;
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function prepareKnowledge(candidate: KnowledgeCandidate, chunkSize = 2400): PreparedKnowledge {
  const content = candidate.content.trim();
  if (!content) throw new Error("knowledge_content_empty");
  if (/(?:sk-|ghp_|sb_secret_|BEGIN PRIVATE KEY)/i.test(content)) throw new Error("knowledge_secret_detected");
  if (candidate.scope === "global" && (!candidate.approvedBy || !candidate.approverIsSuperadmin)) throw new Error("global_knowledge_requires_superadmin_approval");
  const chunks: PreparedKnowledge["chunks"] = [];
  for (let offset = 0, index = 0; offset < content.length; offset += chunkSize, index += 1) {
    const part = content.slice(offset, offset + chunkSize);
    chunks.push({ index, content: part, contentHash: hash(part) });
  }
  return { contentHash: hash(content), approvalStatus: candidate.scope === "global" ? "approved" : "pending", chunks };
}
