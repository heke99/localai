begin;

alter table internal.agent_runs
  add column if not exists mode text not null default 'chat' check (mode in ('chat','code','lab','research')),
  add column if not exists failure_code text,
  add column if not exists active_skill text,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table internal.agent_steps
  add column if not exists finished_at timestamptz,
  add column if not exists duration_ms integer check (duration_ms is null or duration_ms >= 0);

create table internal.run_skill_versions (run_id uuid not null references internal.agent_runs(id) on delete cascade, skill_version_id uuid not null references internal.skill_versions(id), activation_order integer not null check (activation_order > 0), selection_reason text not null, primary key (run_id, skill_version_id), unique (run_id, activation_order));
create table internal.run_artifacts (id uuid primary key default gen_random_uuid(), run_id uuid not null references internal.agent_runs(id) on delete cascade, kind text not null, storage_path text not null, sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'), metadata jsonb not null default '{}', created_at timestamptz not null default now(), unique (run_id, storage_path));
create table internal.policy_sets (id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id) on delete cascade, key text not null, version integer not null check (version > 0), status internal.lifecycle_status not null default 'draft', created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), unique nulls not distinct (organization_id, key, version));
create table internal.policy_rules (id uuid primary key default gen_random_uuid(), policy_set_id uuid not null references internal.policy_sets(id) on delete cascade, priority integer not null, effect text not null check (effect in ('allow','deny')), action text not null, resource_pattern text not null, conditions jsonb not null default '{}', unique (policy_set_id, priority));
create table internal.lab_authorizations (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, project_id uuid references public.projects(id) on delete cascade, target text not null, scope text not null, approved_by uuid not null references auth.users(id), valid_from timestamptz not null, valid_to timestamptz not null, revoked_at timestamptz, evidence_path text, check (valid_to > valid_from));
create index lab_authorizations_active_idx on internal.lab_authorizations (organization_id, valid_to) where revoked_at is null;
create table internal.credential_leases (id uuid primary key default gen_random_uuid(), connection_id uuid not null references internal.integration_connections(id) on delete cascade, run_id uuid not null references internal.agent_runs(id) on delete cascade, actor_user_id uuid not null references auth.users(id), resource text not null, capabilities text[] not null, vault_lease_reference text not null, expires_at timestamptz not null, revoked_at timestamptz, created_at timestamptz not null default now());
create index credential_leases_active_idx on internal.credential_leases (run_id, expires_at) where revoked_at is null;
create table internal.job_queue (id uuid primary key default gen_random_uuid(), queue text not null, run_id uuid references internal.agent_runs(id) on delete cascade, payload jsonb not null, status internal.run_status not null default 'queued', priority integer not null default 100, available_at timestamptz not null default now(), leased_by text, leased_until timestamptz, attempts integer not null default 0, maximum_attempts integer not null default 3, dedupe_key text, last_error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check (attempts >= 0 and maximum_attempts > 0), unique nulls not distinct (queue, dedupe_key));
create index job_queue_claim_idx on internal.job_queue (queue, status, priority, available_at) where status in ('queued','retrying');
create table internal.knowledge_conflicts (id uuid primary key default gen_random_uuid(), source_id uuid not null references internal.knowledge_sources(id) on delete cascade, conflicting_source_id uuid not null references internal.knowledge_sources(id) on delete cascade, reason text not null, status text not null default 'open' check (status in ('open','resolved','dismissed')), resolved_by uuid references auth.users(id), created_at timestamptz not null default now(), check (source_id <> conflicting_source_id));
create table internal.model_health_checks (id bigint generated always as identity primary key, model_deployment_id uuid not null references internal.model_deployments(id) on delete cascade, ok boolean not null, latency_ms integer not null check (latency_ms >= 0), detail_redacted text, observed_at timestamptz not null default now());
create index model_health_checks_deployment_time_idx on internal.model_health_checks (model_deployment_id, observed_at desc);
create table internal.promotion_decisions (id uuid primary key default gen_random_uuid(), model_version_id uuid not null references internal.model_versions(id), from_status internal.lifecycle_status not null, to_status internal.lifecycle_status not null, eval_run_ids uuid[] not null, decision text not null check (decision in ('approved','rejected','rolled_back')), blockers jsonb not null default '[]', decided_by uuid not null references auth.users(id), created_at timestamptz not null default now());
create table internal.research_sources (id uuid primary key default gen_random_uuid(), run_id uuid not null references internal.agent_runs(id) on delete cascade, uri text not null, title text, publisher text, published_at timestamptz, retrieved_at timestamptz not null default now(), content_hash text not null, trust_class text not null check (trust_class in ('primary','secondary','unverified')), unique (run_id, uri, content_hash));

do $$ declare r record; begin
  for r in select schemaname, tablename from pg_tables where schemaname = 'internal' and tablename in ('run_skill_versions','run_artifacts','policy_sets','policy_rules','lab_authorizations','credential_leases','job_queue','knowledge_conflicts','model_health_checks','promotion_decisions','research_sources') loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
    execute format('grant all on table %I.%I to service_role', r.schemaname, r.tablename);
  end loop;
end $$;
grant usage, select on all sequences in schema internal to service_role;

create or replace function internal.has_permission(org_id uuid, permission_key text) returns boolean
language sql stable security definer set search_path = ''
as $$ select internal.is_superadmin() or exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id join public.permissions p on p.id = rp.permission_id where ur.organization_id = org_id and ur.user_id = (select auth.uid()) and p.key = permission_key) $$;
revoke all on function internal.has_permission(uuid, text) from public;
grant execute on function internal.has_permission(uuid, text) to authenticated, service_role;

create or replace function public.start_agent_run(workspace_id uuid, conversation_id uuid, mode text, prompt text, request_id text, trace_id text)
returns table (run_id uuid, resolved_conversation_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare actor_id uuid := auth.uid(); org_id uuid; target_conversation_id uuid := conversation_id; selected_alias text; new_run_id uuid;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if mode not in ('chat','code','lab','research') then raise exception 'invalid_mode'; end if;
  if char_length(trim(prompt)) < 1 or char_length(prompt) > 100000 then raise exception 'invalid_prompt'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id = workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied'; end if;
  if not internal.has_permission(org_id, case when mode = 'lab' then 'lab.run' else 'agent.run' end) then raise exception 'permission_denied'; end if;
  if target_conversation_id is null then
    insert into public.conversations(workspace_id, created_by, mode, title) values (workspace_id, actor_id, mode, left(trim(prompt), 100)) returning id into target_conversation_id;
  elsif not exists (select 1 from public.conversations c where c.id = target_conversation_id and c.workspace_id = start_agent_run.workspace_id) then raise exception 'conversation_access_denied';
  end if;
  insert into public.messages(conversation_id, actor_user_id, role, content) values (target_conversation_id, actor_id, 'user', jsonb_build_object('text', prompt));
  selected_alias := case mode when 'code' then 'code-prod' when 'lab' then 'lab-prod' when 'research' then 'research-prod' else 'general-prod' end;
  insert into internal.agent_runs(conversation_id, organization_id, requested_by, status, request_id, trace_id, model_alias, mode) values (target_conversation_id, org_id, actor_id, 'queued', request_id, trace_id, selected_alias, mode) returning id into new_run_id;
  insert into audit.audit_events(organization_id, actor_user_id, request_id, trace_id, event_type, target_type, target_id, outcome) values (org_id, actor_id, request_id, trace_id, 'agent.run.requested', 'agent_run', new_run_id::text, 'accepted');
  return query select new_run_id, target_conversation_id;
end $$;
revoke all on function public.start_agent_run(uuid, uuid, text, text, text, text) from public;
grant execute on function public.start_agent_run(uuid, uuid, text, text, text, text) to authenticated;

create or replace function public.cancel_agent_run(target_run_id uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$ declare changed boolean; begin update internal.agent_runs r set cancel_requested_at = now(), updated_at = now() where r.id = target_run_id and (r.requested_by = (select auth.uid()) or internal.is_superadmin()) and r.status not in ('completed','failed','cancelled','timed_out') returning true into changed; return coalesce(changed, false); end $$;
revoke all on function public.cancel_agent_run(uuid) from public;
grant execute on function public.cancel_agent_run(uuid) to authenticated;

create or replace function public.get_agent_run(target_run_id uuid)
returns table (id uuid, status text, mode text, model_alias text, failure_code text, cancel_requested_at timestamptz, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = ''
as $$ select r.id, r.status::text, r.mode, r.model_alias, r.failure_code, r.cancel_requested_at, r.created_at, r.updated_at from internal.agent_runs r where r.id = target_run_id and (r.requested_by = (select auth.uid()) or internal.is_superadmin()) $$;
revoke all on function public.get_agent_run(uuid) from public;
grant execute on function public.get_agent_run(uuid) to authenticated;

commit;
