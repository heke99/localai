import type { ProviderKey } from "./oauth";

export interface GatewayTool { name: string; provider: ProviderKey; capability: string; }
const tools: GatewayTool[] = [
  { name: "github_read_file", provider: "github", capability: "github.contents.read" },
  { name: "github_write_file", provider: "github", capability: "github.contents.write" },
  { name: "github_create_branch", provider: "github", capability: "github.branch.create" },
  { name: "github_read_pull_requests", provider: "github", capability: "github.pull_request.read" },
  { name: "github_create_pull_request", provider: "github", capability: "github.pull_request.create" },
  { name: "github_merge_pull_request", provider: "github", capability: "github.pull_request.merge" },
  { name: "github_read_actions", provider: "github", capability: "github.actions.read" },
  { name: "github_run_action", provider: "github", capability: "github.actions.run" },
  { name: "supabase_read_database", provider: "supabase", capability: "supabase.database.read" },
  { name: "supabase_write_database", provider: "supabase", capability: "supabase.database.write" },
  { name: "supabase_apply_migration", provider: "supabase", capability: "supabase.migrations.apply" },
  { name: "supabase_read_logs", provider: "supabase", capability: "supabase.logs.read" },
  { name: "supabase_deploy_function", provider: "supabase", capability: "supabase.functions.write" },
  { name: "vercel_read_deployments", provider: "vercel", capability: "vercel.deployments.read" },
  { name: "vercel_read_logs", provider: "vercel", capability: "vercel.logs.read" },
  { name: "vercel_create_deployment", provider: "vercel", capability: "vercel.deployments.create" },
  { name: "vercel_rollback_deployment", provider: "vercel", capability: "vercel.deployments.rollback" }
];
const byName = new Map(tools.map((tool) => [tool.name, tool]));

export function isForbiddenIntegrationToolName(name: string) {
  const normalized = name.trim().toLowerCase().replace(/[.-]/g, "_");
  return normalized.startsWith("vercel_") && normalized.includes("drain");
}

export function gatewayToolByName(name: string) {
  if (isForbiddenIntegrationToolName(name)) return null;
  return byName.get(name) ?? null;
}
