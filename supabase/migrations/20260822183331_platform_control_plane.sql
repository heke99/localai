begin;

create extension if not exists vector with schema extensions;
create schema if not exists internal;
create schema if not exists training;
create schema if not exists audit;

revoke all on schema internal, training, audit from public, anon, authenticated;
grant usage on schema internal, training, audit to service_role;

create type public.access_request_status as enum ('pending', 'reviewing', 'approved', 'rejected');
create type public.membership_status as enum ('invited', 'active', 'suspended');
create type internal.lifecycle_status as enum ('draft', 'registered', 'verified', 'canary', 'production', 'retired', 'failed');
create type internal.run_status as enum ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled');

create table public.access_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  email text not null check (char_length(email) between 3 and 320),
  organization_name text check (organization_name is null or char_length(organization_name) <= 160),
  use_case text not null check (char_length(use_case) between 20 and 3000),
  status public.access_request_status not null default 'pending',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index access_requests_pending_email_idx on public.access_requests (lower(email)) where status in ('pending', 'reviewing');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 2 and 160),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status public.membership_status not null default 'invited',
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id, organization_id) where status = 'active';

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  key text not null,
  name text not null,
  system_managed boolean not null default false,
  unique nulls not distinct (organization_id, key)
);
create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text not null
);
create table public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);
create table public.user_roles (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (organization_id, user_id, role_id)
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index workspaces_org_idx on public.workspaces (organization_id, created_at desc);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_level text not null check (access_level in ('viewer', 'member', 'admin')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id, workspace_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_workspace_idx on public.projects (workspace_id, updated_at desc);
create table public.project_repositories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  provider text not null check (provider in ('github', 'gitlab', 'other')),
  external_repository_id text not null,
  default_branch text not null,
  installation_reference text,
  created_at timestamptz not null default now(),
  unique (provider, external_repository_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  created_by uuid not null references auth.users(id),
  mode text not null check (mode in ('chat', 'code', 'lab', 'research')),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_workspace_idx on public.conversations (workspace_id, updated_at desc);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content jsonb not null,
  model_version_id uuid,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table internal.agent_definitions (id uuid primary key default gen_random_uuid(), key text not null unique, name text not null, active_version integer not null default 1, created_at timestamptz not null default now());
create table internal.agent_versions (id uuid primary key default gen_random_uuid(), agent_definition_id uuid not null references internal.agent_definitions(id) on delete cascade, version integer not null, definition jsonb not null, created_at timestamptz not null default now(), unique(agent_definition_id, version));
create table internal.agent_runs (id uuid primary key default gen_random_uuid(), conversation_id uuid references public.conversations(id) on delete set null, organization_id uuid not null references public.organizations(id) on delete cascade, requested_by uuid not null references auth.users(id), status internal.run_status not null default 'queued', request_id text not null unique, trace_id text not null, model_alias text not null, started_at timestamptz, finished_at timestamptz, created_at timestamptz not null default now());
create index agent_runs_org_status_idx on internal.agent_runs (organization_id, status, created_at);
create table internal.agent_steps (id uuid primary key default gen_random_uuid(), run_id uuid not null references internal.agent_runs(id) on delete cascade, sequence_no integer not null, kind text not null, status internal.run_status not null, input jsonb, output jsonb, error_code text, created_at timestamptz not null default now(), unique(run_id, sequence_no));
create table internal.agent_checkpoints (id uuid primary key default gen_random_uuid(), run_id uuid not null references internal.agent_runs(id) on delete cascade, step_sequence integer not null, state jsonb not null, artifact_refs jsonb not null default '[]', created_at timestamptz not null default now(), unique(run_id, step_sequence));

create table internal.skills (id uuid primary key default gen_random_uuid(), key text not null unique, category text not null, status internal.lifecycle_status not null default 'draft', active_version integer, created_at timestamptz not null default now());
create table internal.skill_versions (id uuid primary key default gen_random_uuid(), skill_id uuid not null references internal.skills(id) on delete cascade, version integer not null, content_hash text not null, manifest jsonb not null, source_license text, created_at timestamptz not null default now(), unique(skill_id, version));
create table internal.skill_sources (id uuid primary key default gen_random_uuid(), skill_version_id uuid not null references internal.skill_versions(id) on delete cascade, source_url text not null, source_revision text not null, source_hash text not null, review_status text not null check(review_status in ('pending','approved','rejected')), unique(source_url, source_revision));
create table internal.skill_evaluations (id uuid primary key default gen_random_uuid(), skill_version_id uuid not null references internal.skill_versions(id) on delete cascade, suite_key text not null, score numeric, result jsonb not null, created_at timestamptz not null default now());
create table internal.skill_assignments (id uuid primary key default gen_random_uuid(), skill_version_id uuid not null references internal.skill_versions(id) on delete cascade, scope_type text not null, scope_id uuid, enabled boolean not null default true, unique nulls not distinct(skill_version_id, scope_type, scope_id));

create table internal.tool_definitions (id uuid primary key default gen_random_uuid(), key text not null unique, risk_tier text not null, input_schema jsonb not null, required_permissions text[] not null default '{}', created_at timestamptz not null default now());
create table internal.tool_executions (id uuid primary key default gen_random_uuid(), run_id uuid not null references internal.agent_runs(id) on delete cascade, tool_definition_id uuid not null references internal.tool_definitions(id), actor_user_id uuid not null references auth.users(id), status internal.run_status not null, input_redacted jsonb, output_redacted jsonb, started_at timestamptz not null default now(), finished_at timestamptz);
create table internal.integration_connections (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, provider text not null, external_account_id text not null, vault_secret_id uuid, status text not null, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), unique(organization_id, provider, external_account_id));
create table internal.integration_resources (id uuid primary key default gen_random_uuid(), connection_id uuid not null references internal.integration_connections(id) on delete cascade, resource_type text not null, external_id text not null, display_name text, unique(connection_id, resource_type, external_id));
create table internal.integration_capabilities (connection_id uuid not null references internal.integration_connections(id) on delete cascade, capability text not null, granted boolean not null default false, primary key(connection_id, capability));
create table internal.sandboxes (id uuid primary key default gen_random_uuid(), run_id uuid references internal.agent_runs(id) on delete set null, profile text not null check(profile in ('code','lab','browser')), status internal.run_status not null, cpu_limit numeric not null, memory_mb integer not null, network_policy jsonb not null, expires_at timestamptz not null, created_at timestamptz not null default now());

create table internal.knowledge_sources (id uuid primary key default gen_random_uuid(), scope_type text not null, scope_id uuid, source_type text not null, source_uri text, content_hash text not null, provenance jsonb not null, approval_status text not null check(approval_status in ('pending','approved','rejected','superseded')), approved_by uuid references auth.users(id), created_at timestamptz not null default now());
create table internal.knowledge_ingestion_runs (id uuid primary key default gen_random_uuid(), source_id uuid not null references internal.knowledge_sources(id) on delete cascade, status internal.run_status not null, report jsonb, created_at timestamptz not null default now(), finished_at timestamptz);
create table internal.knowledge_items (id uuid primary key default gen_random_uuid(), source_id uuid not null references internal.knowledge_sources(id) on delete cascade, title text, body text not null, metadata jsonb not null default '{}', valid_from timestamptz, valid_to timestamptz, created_at timestamptz not null default now());
create table internal.knowledge_chunks (id uuid primary key default gen_random_uuid(), item_id uuid not null references internal.knowledge_items(id) on delete cascade, chunk_index integer not null, content text not null, token_count integer not null, content_hash text not null, unique(item_id, chunk_index));
create table internal.knowledge_embeddings (chunk_id uuid primary key references internal.knowledge_chunks(id) on delete cascade, embedding extensions.vector(1024) not null, embedding_model text not null, created_at timestamptz not null default now());
create index knowledge_embeddings_hnsw_idx on internal.knowledge_embeddings using hnsw (embedding vector_cosine_ops);
create table internal.memories (id uuid primary key default gen_random_uuid(), scope_type text not null, scope_id uuid not null, memory_type text not null, content jsonb not null, provenance jsonb not null, expires_at timestamptz, created_at timestamptz not null default now());
create table internal.experiences (id uuid primary key default gen_random_uuid(), run_id uuid not null references internal.agent_runs(id) on delete cascade, summary jsonb not null, quality_score numeric, promotion_status text not null default 'candidate', created_at timestamptz not null default now());
create table internal.learning_events (id uuid primary key default gen_random_uuid(), run_id uuid references internal.agent_runs(id) on delete set null, event_type text not null, payload jsonb not null, created_at timestamptz not null default now());

create table internal.models (id uuid primary key default gen_random_uuid(), key text not null unique, family text not null, created_at timestamptz not null default now());
create table internal.model_versions (id uuid primary key default gen_random_uuid(), model_id uuid not null references internal.models(id) on delete cascade, version_key text not null, repository text not null, revision text not null, license text not null, context_window integer not null, capabilities text[] not null, status internal.lifecycle_status not null default 'registered', metadata jsonb not null default '{}', created_at timestamptz not null default now(), unique(model_id, version_key));
create table internal.model_artifacts (id uuid primary key default gen_random_uuid(), model_version_id uuid not null references internal.model_versions(id) on delete cascade, filename text not null, quantization text not null, sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'), bytes bigint not null, tokenizer_sha256 text not null, chat_template_sha256 text not null, unique(model_version_id, filename));
create table internal.model_deployments (id uuid primary key default gen_random_uuid(), model_version_id uuid not null references internal.model_versions(id), environment text not null, traffic_percent numeric not null check(traffic_percent between 0 and 100), runtime_config jsonb not null, status internal.lifecycle_status not null, created_at timestamptz not null default now());
create table internal.model_aliases (alias text primary key, model_version_id uuid not null references internal.model_versions(id), updated_by uuid references auth.users(id), updated_at timestamptz not null default now());
create table internal.adapter_versions (id uuid primary key default gen_random_uuid(), key text not null, version text not null, model_version_id uuid not null references internal.model_versions(id), artifact_sha256 text not null, status internal.lifecycle_status not null, unique(key, version));

create table internal.eval_suites (id uuid primary key default gen_random_uuid(), key text not null unique, version integer not null, holdout boolean not null default false, definition jsonb not null);
create table internal.eval_cases (id uuid primary key default gen_random_uuid(), suite_id uuid not null references internal.eval_suites(id) on delete cascade, case_key text not null, input jsonb not null, expected jsonb, unique(suite_id, case_key));
create table internal.eval_runs (id uuid primary key default gen_random_uuid(), suite_id uuid not null references internal.eval_suites(id), model_version_id uuid references internal.model_versions(id), status internal.run_status not null, created_at timestamptz not null default now(), finished_at timestamptz);
create table internal.eval_results (id uuid primary key default gen_random_uuid(), eval_run_id uuid not null references internal.eval_runs(id) on delete cascade, eval_case_id uuid not null references internal.eval_cases(id), score numeric, metrics jsonb not null, unique(eval_run_id, eval_case_id));

create table internal.gpu_providers (id uuid primary key default gen_random_uuid(), key text not null unique, configuration jsonb not null default '{}', enabled boolean not null default false);
create table internal.gpu_workers (id uuid primary key default gen_random_uuid(), provider_id uuid not null references internal.gpu_providers(id), external_worker_id text not null, profile text not null, state text not null, model_version_id uuid references internal.model_versions(id), last_heartbeat_at timestamptz, created_at timestamptz not null default now(), unique(provider_id, external_worker_id));
create table internal.gpu_metrics (worker_id uuid not null references internal.gpu_workers(id) on delete cascade, observed_at timestamptz not null, utilization numeric, vram_used_bytes bigint, active_generations integer, queue_depth integer, ttft_ms integer, tokens_per_second numeric, primary key(worker_id, observed_at));
create table internal.autoscaling_policies (id uuid primary key default gen_random_uuid(), profile text not null unique, minimum_warm integer not null, maximum_workers integer not null, thresholds jsonb not null, enabled boolean not null default false);
create table internal.autoscaling_events (id uuid primary key default gen_random_uuid(), policy_id uuid not null references internal.autoscaling_policies(id), action text not null, reason jsonb not null, created_at timestamptz not null default now());
create table internal.usage_events (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), user_id uuid not null references auth.users(id), run_id uuid references internal.agent_runs(id), model_version_id uuid references internal.model_versions(id), input_tokens bigint not null default 0, output_tokens bigint not null default 0, cached_tokens bigint not null default 0, gpu_seconds numeric not null default 0, sandbox_seconds numeric not null default 0, queue_ms integer not null default 0, cost_minor numeric not null default 0, occurred_at timestamptz not null default now());
create index usage_events_org_time_idx on internal.usage_events (organization_id, occurred_at desc);
create table internal.usage_daily (organization_id uuid not null references public.organizations(id), usage_date date not null, totals jsonb not null, primary key(organization_id, usage_date));
create table internal.usage_monthly (organization_id uuid not null references public.organizations(id), usage_month date not null, totals jsonb not null, primary key(organization_id, usage_month));

create table training.dataset_candidates (id uuid primary key default gen_random_uuid(), experience_id uuid references internal.experiences(id), status text not null default 'pending', reviewed_by uuid references auth.users(id), created_at timestamptz not null default now());
create table training.datasets (id uuid primary key default gen_random_uuid(), key text not null unique, description text, created_at timestamptz not null default now());
create table training.dataset_versions (id uuid primary key default gen_random_uuid(), dataset_id uuid not null references training.datasets(id) on delete cascade, version integer not null, content_hash text not null, status internal.lifecycle_status not null, created_at timestamptz not null default now(), unique(dataset_id, version));
create table training.dataset_examples (id uuid primary key default gen_random_uuid(), dataset_version_id uuid not null references training.dataset_versions(id) on delete cascade, input jsonb not null, expected jsonb not null, provenance jsonb not null, unique(dataset_version_id, id));
create table training.training_runs (id uuid primary key default gen_random_uuid(), base_model_version_id uuid not null references internal.model_versions(id), dataset_version_id uuid not null references training.dataset_versions(id), recipe jsonb not null, status internal.run_status not null, resulting_artifact_sha256 text, created_at timestamptz not null default now(), finished_at timestamptz);

create table audit.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  request_id text,
  trace_id text,
  event_type text not null,
  target_type text,
  target_id text,
  outcome text not null,
  metadata_redacted jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index audit_events_org_time_idx on audit.audit_events (organization_id, occurred_at desc);

alter table public.messages add constraint messages_model_version_fk foreign key (model_version_id) references internal.model_versions(id) on delete set null;

create or replace function internal.is_superadmin() returns boolean
language sql stable security invoker set search_path = ''
as $$ select coalesce((auth.jwt() -> 'app_metadata' ->> 'system_role') = 'superadmin', false) $$;

create or replace function internal.is_org_member(org_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.organization_members m where m.organization_id = org_id and m.user_id = (select auth.uid()) and m.status = 'active') or internal.is_superadmin() $$;

create or replace function internal.is_workspace_member(ws_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.workspace_members m where m.workspace_id = ws_id and m.user_id = (select auth.uid())) or internal.is_superadmin() $$;

revoke all on function internal.is_superadmin(), internal.is_org_member(uuid), internal.is_workspace_member(uuid) from public;
grant execute on function internal.is_superadmin(), internal.is_org_member(uuid), internal.is_workspace_member(uuid) to authenticated, service_role;

alter table public.access_requests enable row level security;
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.project_repositories enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy access_requests_anon_insert on public.access_requests for insert to anon with check (status = 'pending' and reviewed_by is null and reviewed_at is null);
create policy access_requests_superadmin_select on public.access_requests for select to authenticated using (internal.is_superadmin() and (select auth.jwt()->>'aal') = 'aal2');
create policy access_requests_superadmin_update on public.access_requests for update to authenticated using (internal.is_superadmin() and (select auth.jwt()->>'aal') = 'aal2') with check (internal.is_superadmin() and (select auth.jwt()->>'aal') = 'aal2');
create policy profiles_self_select on public.profiles for select to authenticated using ((select auth.uid()) = user_id or internal.is_superadmin());
create policy profiles_self_update on public.profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy organizations_member_select on public.organizations for select to authenticated using (internal.is_org_member(id));
create policy organization_members_member_select on public.organization_members for select to authenticated using (internal.is_org_member(organization_id));
create policy roles_member_select on public.roles for select to authenticated using (organization_id is null or internal.is_org_member(organization_id));
create policy permissions_authenticated_select on public.permissions for select to authenticated using (true);
create policy role_permissions_member_select on public.role_permissions for select to authenticated using (exists(select 1 from public.roles r where r.id = role_id and (r.organization_id is null or internal.is_org_member(r.organization_id))));
create policy user_roles_member_select on public.user_roles for select to authenticated using (internal.is_org_member(organization_id));
create policy workspaces_member_select on public.workspaces for select to authenticated using (internal.is_workspace_member(id));
create policy workspace_members_member_select on public.workspace_members for select to authenticated using (internal.is_workspace_member(workspace_id));
create policy projects_workspace_access on public.projects for select to authenticated using (internal.is_workspace_member(workspace_id));
create policy project_repositories_workspace_access on public.project_repositories for select to authenticated using (exists(select 1 from public.projects p where p.id = project_id and internal.is_workspace_member(p.workspace_id)));
create policy conversations_workspace_access on public.conversations for select to authenticated using (internal.is_workspace_member(workspace_id));
create policy messages_conversation_access on public.messages for select to authenticated using (exists(select 1 from public.conversations c where c.id = conversation_id and internal.is_workspace_member(c.workspace_id)));

revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant insert on public.access_requests to anon;
grant select, update on public.access_requests to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.organizations, public.organization_members, public.roles, public.permissions, public.role_permissions, public.user_roles, public.workspaces, public.workspace_members, public.projects, public.project_repositories, public.conversations, public.messages to authenticated;

do $$ declare r record; begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('internal','training','audit') loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
    execute format('grant all on table %I.%I to service_role', r.schemaname, r.tablename);
  end loop;
end $$;

insert into public.permissions(key, description) values
('project.read','Read projects'), ('project.write','Create and update projects'), ('agent.run','Run agents'),
('lab.run','Run authorized Lab tasks'), ('integration.manage','Manage integrations'), ('knowledge.global.write','Approve global knowledge'),
('model.manage','Manage model registry and promotion'), ('gpu.manage','Manage GPU capacity'), ('audit.read','Read audit events');

insert into public.roles(organization_id, key, name, system_managed) values
(null, 'member', 'Member', true), (null, 'organization_admin', 'Organization admin', true), (null, 'superadmin', 'Superadmin', true);

insert into internal.models(key, family) values ('qwen38-27b-obliterated', 'qwen3.8');
insert into internal.model_versions(model_id, version_key, repository, revision, license, context_window, capabilities, status, metadata)
select id, 'v2-q8-0', 'OBLITERATUS/Qwen3.8-27B-OBLITERATED', 'e335d239dbdfae590687e24b800e81a18d070ebe', 'apache-2.0', 262144,
array['general','reasoning','coding','security','research','long_context','tool_use','verification'], 'registered',
'{"runtime_adapter":"llama.cpp-openai","promotion_blocked_until_runtime_pinned":true}'::jsonb from internal.models where key = 'qwen38-27b-obliterated';
insert into internal.model_artifacts(model_version_id, filename, quantization, sha256, bytes, tokenizer_sha256, chat_template_sha256)
select id, 'Qwen3.8-27B-OBLITERATED-Q8_0.gguf', 'Q8_0', '4cfb568f17fb58a0373279cc3b73602a350e25aea2953ce087dcea6b51fa6f3c', 29047084320,
'0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3', '1bffd744ab18e11623af60636410ca4a1f3e544c9fc52d3ddee6bf3da341419f'
from internal.model_versions where version_key = 'v2-q8-0';
insert into internal.model_aliases(alias, model_version_id)
select a.alias, mv.id from internal.model_versions mv cross join unnest(array['general-prod','code-prod','lab-prod','reasoner-prod','research-prod','verifier-prod']) as a(alias)
where mv.version_key = 'v2-q8-0';
insert into internal.gpu_providers(key, configuration, enabled) values ('hyperstack','{}',false),('runpod','{}',false);
insert into internal.autoscaling_policies(profile, minimum_warm, maximum_workers, thresholds, enabled)
values ('large_96gb', 1, 4, '{"queue_p95_ms":3000,"gpu_utilization_high":85,"gpu_utilization_low":30}', false);

commit;
