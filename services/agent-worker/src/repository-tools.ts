import type { ModelToolCall, ModelToolDefinition } from "@div3rsa/model-sdk";
import { searchRepository } from "@div3rsa/repository-intelligence";
import type { PreparedRepositoryWorkspace } from "./repository-runtime";

export const REPOSITORY_SEARCH_TOOL = "div3rsa_repository_search";
export const REPOSITORY_READ_TOOL = "div3rsa_repository_read_indexed_file";

export function repositoryToolDefinitions(workspace: PreparedRepositoryWorkspace | null): ModelToolDefinition[] {
  if (!workspace) return [];
  return [
    {
      name: REPOSITORY_SEARCH_TOOL,
      description: "Search the exact indexed repository revision for relevant files, symbols, routes and database entities before editing code.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 30 }
        }
      }
    },
    {
      name: REPOSITORY_READ_TOOL,
      description: "Read a text file from the exact indexed repository revision. This is read-only and does not use provider credentials.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } }
      }
    }
  ];
}

export function executeRepositoryTool(workspace: PreparedRepositoryWorkspace | null, call: ModelToolCall): unknown | undefined {
  if (!workspace) return undefined;
  if (call.name === REPOSITORY_SEARCH_TOOL) {
    const query = typeof call.input.query === "string" ? call.input.query.trim() : "";
    if (!query) throw new Error("repository_search_query_required");
    const limit = Math.min(30, Math.max(1, Number(call.input.limit) || 12));
    const matches = searchRepository(workspace.index, query, limit).map((match) => ({
      ...match,
      routes: workspace.index.routes.filter((route) => route.file === match.path).map((route) => ({ path: route.path, kind: route.kind, methods: route.methods })),
      database: workspace.index.databaseEntities.filter((entity) => entity.file === match.path).map((entity) => ({ name: entity.name, kind: entity.kind }))
    }));
    return { repository: workspace.repository, ref: workspace.ref, revision: workspace.revision, complete: workspace.complete, matches };
  }
  if (call.name === REPOSITORY_READ_TOOL) {
    const requested = typeof call.input.path === "string" ? call.input.path.replace(/^\.\//, "") : "";
    const file = workspace.index.files.find((candidate) => candidate.path === requested);
    if (!file) throw new Error("repository_indexed_file_not_found");
    if (file.content.length > 120_000) throw new Error("repository_indexed_file_too_large");
    return { path: file.path, revision: workspace.revision, hash: file.hash, language: file.language, content: file.content };
  }
  return undefined;
}
