import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepositoryIndex, type RepositoryIndex } from "@div3rsa/repository-intelligence";
import type { ClaimedRun } from "./processor";

type RpcClient = { rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown | null; error: { message: string } | null }> };

interface SnapshotFile { path: string; content: string; blobSha: string; size: number }
interface SnapshotPage {
  repository: string;
  ref: string;
  revisionSha: string;
  treeSha: string;
  treeTruncated: boolean;
  eligibleFileCount: number;
  cursor: number;
  nextCursor: number | null;
  files: SnapshotFile[];
  complete: boolean;
}

export interface PreparedRepositoryWorkspace {
  resourceId: string;
  repository: string;
  ref: string;
  revision: string;
  complete: boolean;
  workspacePath: string;
  index: RepositoryIndex;
}

export interface WorkerRepositoryRuntime {
  prepare(run: ClaimedRun, ref?: string): Promise<PreparedRepositoryWorkspace | null>;
  release(workspace: PreparedRepositoryWorkspace): Promise<void>;
}

function isSnapshotPage(value: unknown): value is SnapshotPage {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.repository === "string"
    && typeof item.ref === "string"
    && typeof item.revisionSha === "string"
    && typeof item.treeSha === "string"
    && typeof item.treeTruncated === "boolean"
    && typeof item.eligibleFileCount === "number"
    && typeof item.cursor === "number"
    && (typeof item.nextCursor === "number" || item.nextCursor === null)
    && Array.isArray(item.files)
    && typeof item.complete === "boolean";
}

function safeRelativePath(filePath: string) {
  const normalized = path.posix.normalize(filePath.replace(/^\.\//, "").replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0")) throw new Error("repository_snapshot_path_invalid");
  return normalized;
}

function repositoryResource(run: ClaimedRun) {
  return run.resourceContext.find((resource) => resource.provider === "github" && resource.resourceType === "repository" && resource.capabilities.includes("github.contents.read"));
}

export class RemoteRepositoryWorkspaceRuntime implements WorkerRepositoryRuntime {
  constructor(
    private readonly client: RpcClient,
    private readonly gatewayUrl: string,
    private readonly rootPath: string = process.env.DIV3RSA_WORKSPACE_TMP_ROOT?.trim() || tmpdir()
  ) {}

  private async snapshotPage(run: ClaimedRun, resourceId: string, ref: string, cursor: number): Promise<SnapshotPage> {
    const { data, error } = await this.client.rpc("worker_create_tool_execution_grant", {
      target_run_id: run.runId,
      target_resource_id: resourceId,
      target_capability: "github.contents.read",
      target_tool_name: "github_read_repository_snapshot"
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error(error?.message ?? "repository_snapshot_grant_failed");
    const grantId = (data as Record<string, unknown>).executionGrantId;
    if (typeof grantId !== "string") throw new Error("repository_snapshot_grant_invalid");

    const response = await fetch(this.gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grantId, toolName: "github_read_repository_snapshot", args: { resourceId, ref, cursor, maxBytes: 800_000 } }),
      signal: AbortSignal.timeout(120_000)
    });
    const body = await response.json().catch(() => null) as { result?: unknown; error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? `repository_snapshot_gateway_${response.status}`);
    if (!body || !isSnapshotPage(body.result)) throw new Error("repository_snapshot_response_invalid");
    return body.result;
  }

  async prepare(run: ClaimedRun, requestedRef?: string): Promise<PreparedRepositoryWorkspace | null> {
    const resource = repositoryResource(run);
    if (!resource) return null;
    const metadata = resource.metadata ?? {};
    const defaultBranch = typeof metadata.defaultBranch === "string" && metadata.defaultBranch ? metadata.defaultBranch : "main";
    const ref = requestedRef?.trim() || defaultBranch;
    const files = new Map<string, SnapshotFile>();
    let cursor = 0;
    let revision = "";
    let repository = resource.displayName;
    let complete = false;

    for (let pageNumber = 0; pageNumber < 128; pageNumber += 1) {
      const page = await this.snapshotPage(run, resource.resourceId, ref, cursor);
      if (revision && revision !== page.revisionSha) throw new Error("repository_snapshot_revision_changed");
      revision = page.revisionSha;
      repository = page.repository;
      if (page.treeTruncated) complete = false;
      for (const file of page.files) {
        if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("repository_snapshot_file_invalid");
        const normalized = safeRelativePath(file.path);
        files.set(normalized, { ...file, path: normalized });
      }
      if (files.size > 20_000) throw new Error("repository_snapshot_file_limit_exceeded");
      if (page.nextCursor === null) {
        complete = page.complete && !page.treeTruncated;
        break;
      }
      if (page.nextCursor <= cursor) throw new Error("repository_snapshot_cursor_stalled");
      cursor = page.nextCursor;
      if (pageNumber === 127) throw new Error("repository_snapshot_page_limit_exceeded");
    }

    if (!revision || files.size === 0) throw new Error("repository_snapshot_empty");
    await mkdir(this.rootPath, { recursive: true });
    const workspacePath = await mkdtemp(path.join(this.rootPath, "div3rsa-repo-"));
    try {
      for (const file of files.values()) {
        const target = path.resolve(workspacePath, file.path);
        const root = `${path.resolve(workspacePath)}${path.sep}`;
        if (!target.startsWith(root)) throw new Error("repository_snapshot_path_escape");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
      const index = buildRepositoryIndex(resource.resourceId, [...files.values()].map((file) => ({ path: file.path, content: file.content })));
      return { resourceId: resource.resourceId, repository, ref, revision, complete, workspacePath, index };
    } catch (error) {
      await rm(workspacePath, { recursive: true, force: true });
      throw error;
    }
  }

  async release(workspace: PreparedRepositoryWorkspace): Promise<void> {
    await rm(workspace.workspacePath, { recursive: true, force: true });
  }
}
