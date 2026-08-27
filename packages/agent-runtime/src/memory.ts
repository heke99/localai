export type MemoryKind = "conversation" | "project" | "knowledge" | "policy";
export type MemoryTrust = "unverified" | "verified" | "authoritative";
export type MemorySourceType = "conversation" | "project" | "ingestion" | "policy" | "runtime";

export interface MemoryScope {
  organizationId: string;
  workspaceId?: string;
  projectId?: string;
  conversationId?: string;
  userId?: string;
}

export interface MemorySource {
  type: MemorySourceType;
  reference: string;
  approved: boolean;
  workflowRunId?: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  content: string;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  trust: MemoryTrust;
  scope: MemoryScope;
  version: number;
  expiresAt: string | null;
}

export interface MemoryQuery {
  scope: MemoryScope;
  kinds?: MemoryKind[];
  minimumTrust?: MemoryTrust;
  now?: Date;
}

const trustRank: Record<MemoryTrust, number> = { unverified: 0, verified: 1, authoritative: 2 };
const durableKinds = new Set<MemoryKind>(["project", "knowledge", "policy"]);

function required(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}

export function memoryPartitionKey(record: Pick<MemoryRecord, "kind" | "scope">): string {
  const scope = record.scope;
  switch (record.kind) {
    case "conversation":
      return `conversation:${required(scope.organizationId, "memory_org_required")}:${required(scope.workspaceId, "memory_workspace_required")}:${required(scope.userId, "memory_user_required")}:${required(scope.conversationId, "memory_conversation_required")}`;
    case "project":
      return `project:${required(scope.organizationId, "memory_org_required")}:${required(scope.workspaceId, "memory_workspace_required")}:${required(scope.projectId, "memory_project_required")}`;
    case "knowledge":
      return `knowledge:${required(scope.organizationId, "memory_org_required")}:${scope.workspaceId?.trim() || "org"}:${scope.projectId?.trim() || "all"}`;
    case "policy":
      return `policy:${required(scope.organizationId, "memory_org_required")}:${scope.workspaceId?.trim() || "org"}`;
  }
}

export function validateMemoryWrite(record: MemoryRecord): void {
  required(record.id, "memory_id_required");
  required(record.content, "memory_content_required");
  required(record.source.reference, "memory_source_required");
  if (!Number.isInteger(record.version) || record.version < 1) throw new Error("memory_version_invalid");
  if (Number.isNaN(Date.parse(record.createdAt)) || Number.isNaN(Date.parse(record.updatedAt))) throw new Error("memory_timestamp_invalid");
  if (record.expiresAt !== null && Number.isNaN(Date.parse(record.expiresAt))) throw new Error("memory_expiry_invalid");
  memoryPartitionKey(record);
  if (durableKinds.has(record.kind) && !record.source.approved) throw new Error("durable_memory_approval_required");
  if (record.kind === "policy" && (record.source.type !== "policy" || record.trust !== "authoritative")) throw new Error("policy_memory_authority_required");
  if (record.kind === "knowledge" && !["ingestion", "project"].includes(record.source.type)) throw new Error("knowledge_ingestion_source_required");
}

function scopeMatches(record: MemoryRecord, requested: MemoryScope): boolean {
  if (record.scope.organizationId !== requested.organizationId) return false;
  if (record.scope.workspaceId && record.scope.workspaceId !== requested.workspaceId) return false;
  if (record.scope.projectId && record.scope.projectId !== requested.projectId) return false;
  if (record.scope.conversationId && record.scope.conversationId !== requested.conversationId) return false;
  if (record.scope.userId && record.scope.userId !== requested.userId) return false;
  return true;
}

export function selectMemories(records: MemoryRecord[], query: MemoryQuery): MemoryRecord[] {
  const now = (query.now ?? new Date()).getTime();
  const minimumTrust = query.minimumTrust ?? "unverified";
  const kinds = query.kinds ? new Set(query.kinds) : null;
  return records
    .filter((record) => {
      validateMemoryWrite(record);
      if (kinds && !kinds.has(record.kind)) return false;
      if (trustRank[record.trust] < trustRank[minimumTrust]) return false;
      if (!scopeMatches(record, query.scope)) return false;
      if (record.expiresAt !== null && Date.parse(record.expiresAt) <= now) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.version - a.version);
}

export class MemoryEngine {
  constructor(private readonly records: MemoryRecord[] = []) {
    for (const record of records) validateMemoryWrite(record);
  }

  add(record: MemoryRecord): void {
    validateMemoryWrite(record);
    const duplicate = this.records.find((item) => item.id === record.id && item.version === record.version);
    if (duplicate) throw new Error("memory_version_duplicate");
    this.records.push(record);
  }

  select(query: MemoryQuery): MemoryRecord[] {
    return selectMemories(this.records, query);
  }

  partitions(): Map<string, MemoryRecord[]> {
    const partitions = new Map<string, MemoryRecord[]>();
    for (const record of this.records) {
      const key = memoryPartitionKey(record);
      partitions.set(key, [...(partitions.get(key) ?? []), record]);
    }
    return partitions;
  }
}
