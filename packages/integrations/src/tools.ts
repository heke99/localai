import type { ModelToolDefinition } from "@div3rsa/model-sdk";

export type IntegrationProvider = "github" | "supabase" | "vercel";
export type IntegrationRisk = "read" | "write" | "destructive" | "sensitive";

export interface IntegrationResourceContext {
  resourceId: string;
  connectionId: string;
  provider: string;
  resourceType: string;
  externalResourceId: string;
  displayName: string;
  capabilities: string[];
}

export interface IntegrationToolDefinition extends ModelToolDefinition {
  provider: IntegrationProvider;
  capability: string;
  risk: IntegrationRisk;
  internalOnly?: boolean;
}

const resourceProperty = { type: "string", description: "Selected DIV3RSA integration resource id" };

export const INTEGRATION_TOOL_DEFINITIONS: readonly IntegrationToolDefinition[] = [
  { name: "github_read_file", provider: "github", capability: "github.contents.read", risk: "read", description: "Read a file from the selected GitHub repository.", inputSchema: { type: "object", required: ["resourceId", "path"], properties: { resourceId: resourceProperty, path: { type: "string" }, ref: { type: "string" } } } },
  { name: "github_write_file", provider: "github", capability: "github.contents.write", risk: "write", description: "Create or update a file in the selected GitHub repository.", inputSchema: { type: "object", required: ["resourceId", "path", "content", "message", "branch"], properties: { resourceId: resourceProperty, path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, branch: { type: "string" } } } },
  { name: "github_read_branch_ref", provider: "github", capability: "github.contents.read", risk: "read", internalOnly: true, description: "Internal checkpoint primitive for reading an exact branch head.", inputSchema: { type: "object", required: ["resourceId", "branch"], properties: { resourceId: resourceProperty, branch: { type: "string" } } } },
  { name: "github_restore_agent_branch", provider: "github", capability: "github.contents.write", risk: "destructive", internalOnly: true, description: "Internal rewind primitive restricted to DIV3RSA-owned agent branches.", inputSchema: { type: "object", required: ["resourceId", "branch", "targetSha"], properties: { resourceId: resourceProperty, branch: { type: "string" }, targetSha: { type: "string" } } } },
  { name: "github_create_branch", provider: "github", capability: "github.branch.create", risk: "write", description: "Create a branch in the selected GitHub repository.", inputSchema: { type: "object", required: ["resourceId", "branch", "baseRef"], properties: { resourceId: resourceProperty, branch: { type: "string" }, baseRef: { type: "string" } } } },
  { name: "github_read_pull_requests", provider: "github", capability: "github.pull_request.read", risk: "read", description: "Read pull requests in the selected GitHub repository.", inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: resourceProperty, state: { type: "string", enum: ["open", "closed", "all"] } } } },
  { name: "github_create_pull_request", provider: "github", capability: "github.pull_request.create", risk: "write", description: "Create a pull request in the selected GitHub repository.", inputSchema: { type: "object", required: ["resourceId", "title", "head", "base"], properties: { resourceId: resourceProperty, title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" } } } },
  { name: "github_merge_pull_request", provider: "github", capability: "github.pull_request.merge", risk: "destructive", description: "Merge a pull request when the user explicitly granted merge capability.", inputSchema: { type: "object", required: ["resourceId", "pullNumber"], properties: { resourceId: resourceProperty, pullNumber: { type: "integer" }, mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] } } } },
  { name: "github_read_actions", provider: "github", capability: "github.actions.read", risk: "read", description: "Read workflow runs and logs from the selected repository.", inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: resourceProperty, branch: { type: "string" } } } },
  { name: "github_run_action", provider: "github", capability: "github.actions.run", risk: "write", description: "Dispatch an allowed GitHub Actions workflow.", inputSchema: { type: "object", required: ["resourceId", "workflow", "ref"], properties: { resourceId: resourceProperty, workflow: { type: "string" }, ref: { type: "string" }, inputs: { type: "object" } } } },
  { name: "supabase_read_database", provider: "supabase", capability: "supabase.database.read", risk: "read", description: "Run a read-only database operation against the selected Supabase project.", inputSchema: { type: "object", required: ["resourceId", "query"], properties: { resourceId: resourceProperty, query: { type: "string" } } } },
  { name: "supabase_write_database", provider: "supabase", capability: "supabase.database.write", risk: "write", description: "Run an approved data-changing database operation against the selected Supabase project.", inputSchema: { type: "object", required: ["resourceId", "query"], properties: { resourceId: resourceProperty, query: { type: "string" } } } },
  { name: "supabase_apply_migration", provider: "supabase", capability: "supabase.migrations.apply", risk: "destructive", description: "Apply a schema migration to the selected Supabase project.", inputSchema: { type: "object", required: ["resourceId", "name", "sql"], properties: { resourceId: resourceProperty, name: { type: "string" }, sql: { type: "string" } } } },
  { name: "supabase_read_logs", provider: "supabase", capability: "supabase.logs.read", risk: "read", description: "Read logs from the selected Supabase project.", inputSchema: { type: "object", required: ["resourceId", "service"], properties: { resourceId: resourceProperty, service: { type: "string" } } } },
  { name: "supabase_deploy_function", provider: "supabase", capability: "supabase.functions.write", risk: "write", description: "Deploy or update an Edge Function in the selected Supabase project.", inputSchema: { type: "object", required: ["resourceId", "name", "files"], properties: { resourceId: resourceProperty, name: { type: "string" }, files: { type: "array" }, verifyJwt: { type: "boolean" } } } },
  { name: "vercel_read_deployments", provider: "vercel", capability: "vercel.deployments.read", risk: "read", description: "Read deployments for the selected Vercel project.", inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: resourceProperty } } },
  { name: "vercel_read_logs", provider: "vercel", capability: "vercel.logs.read", risk: "read", description: "Read build or runtime logs for the selected Vercel project.", inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: resourceProperty, deploymentId: { type: "string" }, since: { type: "string" } } } },
  { name: "vercel_create_deployment", provider: "vercel", capability: "vercel.deployments.create", risk: "write", description: "Create or redeploy the selected Vercel project.", inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: resourceProperty, ref: { type: "string" } } } },
  { name: "vercel_rollback_deployment", provider: "vercel", capability: "vercel.deployments.rollback", risk: "destructive", description: "Rollback the selected Vercel project to an earlier deployment.", inputSchema: { type: "object", required: ["resourceId", "deploymentId"], properties: { resourceId: resourceProperty, deploymentId: { type: "string" } } } }
] as const;

export function integrationToolsForResources(resources: readonly IntegrationResourceContext[], enabledProviders?: ReadonlySet<string>): ModelToolDefinition[] {
  const capabilities = new Set(resources.flatMap((resource) => resource.capabilities));
  return INTEGRATION_TOOL_DEFINITIONS
    .filter((tool) => !tool.internalOnly && capabilities.has(tool.capability) && (!enabledProviders || enabledProviders.has(tool.provider)))
    .map((tool) => {
      const allowedIds = resources.filter((resource) => resource.provider === tool.provider && resource.capabilities.includes(tool.capability)).map((resource) => resource.resourceId);
      const properties = { ...((tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {}), resourceId: { ...resourceProperty, enum: allowedIds } };
      return { name: tool.name, description: tool.description, inputSchema: { ...tool.inputSchema, properties } };
    });
}

export function integrationToolByName(name: string): IntegrationToolDefinition | undefined {
  return INTEGRATION_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
