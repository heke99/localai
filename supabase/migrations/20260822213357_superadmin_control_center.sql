begin;

create table if not exists internal.bootstrap_tokens (
  id uuid primary key default gen_random_uuid(),
  purpose text not null unique,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  email text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table internal.bootstrap_tokens enable row level security;
revoke all on internal.bootstrap_tokens from public, anon, authenticated;
grant all on internal.bootstrap_tokens to service_role;

insert into internal.bootstrap_tokens(purpose, token_hash, email, expires_at, consumed_at)
values (
  'initial_superadmin',
  'b51c83dcc2cc328ea0ea2f886cd9bde3c951278591494907178d1d1cab69d6fb',
  'hekmat.h@div3rsa.com',
  now() + interval '2 hours',
  null
)
on conflict (purpose) do update
set token_hash = excluded.token_hash,
    email = excluded.email,
    expires_at = excluded.expires_at,
    consumed_at = null;

create or replace function public.bootstrap_initial_superadmin(
  provided_token_hash text,
  target_user_id uuid,
  target_email text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  bootstrap_row internal.bootstrap_tokens%rowtype;
  verified_email text;
  internal_org_id uuid;
  internal_workspace_id uuid;
  superadmin_role_id uuid;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') and session_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into bootstrap_row
  from internal.bootstrap_tokens
  where purpose = 'initial_superadmin'
  for update;

  if not found
     or bootstrap_row.consumed_at is not null
     or bootstrap_row.expires_at <= now()
     or bootstrap_row.token_hash <> provided_token_hash
     or lower(bootstrap_row.email) <> lower(target_email) then
    raise exception 'invalid_or_expired_bootstrap_token' using errcode = '42501';
  end if;

  select lower(email) into verified_email
  from auth.users
  where id = target_user_id;

  if verified_email is null or verified_email <> lower(target_email) then
    raise exception 'bootstrap_user_email_mismatch' using errcode = '42501';
  end if;

  if exists (
    select 1 from auth.users u
    where u.id <> target_user_id
      and coalesce(u.raw_app_meta_data ->> 'system_role', '') = 'superadmin'
  ) then
    raise exception 'superadmin_already_exists' using errcode = '42501';
  end if;

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('system_role', 'superadmin'),
      updated_at = now()
  where id = target_user_id;

  insert into public.organizations(slug, name, created_by)
  values ('div3rsa-internal', 'DIV3RSA Internal', target_user_id)
  on conflict (slug) do update set name = excluded.name
  returning id into internal_org_id;

  select id into internal_workspace_id
  from public.workspaces
  where organization_id = internal_org_id and name = 'Internal workspace'
  order by created_at asc
  limit 1;

  if internal_workspace_id is null then
    insert into public.workspaces(organization_id, name, created_by)
    values (internal_org_id, 'Internal workspace', target_user_id)
    returning id into internal_workspace_id;
  end if;

  insert into public.profiles(user_id, display_name)
  values (target_user_id, 'Hekmat')
  on conflict (user_id) do update
  set display_name = excluded.display_name,
      updated_at = now();

  insert into public.organization_members(organization_id, user_id, status, joined_at)
  values (internal_org_id, target_user_id, 'active', now())
  on conflict (organization_id, user_id) do update
  set status = 'active',
      joined_at = coalesce(public.organization_members.joined_at, excluded.joined_at);

  select id into superadmin_role_id
  from public.roles
  where organization_id is null and key = 'superadmin'
  limit 1;

  if superadmin_role_id is null then
    raise exception 'superadmin_role_missing';
  end if;

  insert into public.user_roles(organization_id, user_id, role_id, granted_by)
  values (internal_org_id, target_user_id, superadmin_role_id, target_user_id)
  on conflict (organization_id, user_id, role_id) do nothing;

  insert into public.workspace_members(workspace_id, user_id, access_level)
  values (internal_workspace_id, target_user_id, 'admin')
  on conflict (workspace_id, user_id) do update
  set access_level = excluded.access_level;

  update internal.bootstrap_tokens
  set consumed_at = now()
  where id = bootstrap_row.id;

  insert into audit.audit_events(
    organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    internal_org_id, target_user_id, 'system.superadmin.bootstrapped', 'user', target_user_id::text, 'completed',
    jsonb_build_object('workspace_id', internal_workspace_id)
  );

  return jsonb_build_object(
    'user_id', target_user_id,
    'organization_id', internal_org_id,
    'workspace_id', internal_workspace_id
  );
end;
$$;

create or replace function public.superadmin_set_model_alias(
  target_alias text,
  target_model_version_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not internal.is_superadmin_aal2() then
    raise exception 'superadmin_aal2_required' using errcode = '42501';
  end if;

  if target_alias not in ('general-prod','code-prod','lab-prod','research-prod','reasoner-prod','verifier-prod') then
    raise exception 'model_alias_not_allowed';
  end if;

  if not exists (
    select 1 from internal.model_versions mv
    where mv.id = target_model_version_id
      and mv.status not in ('draft','retired','failed')
  ) then
    raise exception 'model_version_not_selectable';
  end if;

  insert into internal.model_aliases(alias, model_version_id, updated_by, updated_at)
  values (target_alias, target_model_version_id, auth.uid(), now())
  on conflict (alias) do update
  set model_version_id = excluded.model_version_id,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (auth.uid(),'model.alias.changed','model_alias',target_alias,'completed',jsonb_build_object('model_version_id',target_model_version_id));

  return true;
end;
$$;

create or replace function public.superadmin_create_lab_authorization(
  target_organization_id uuid,
  target_project_id uuid,
  target_target text,
  target_scope text,
  valid_hours integer default 24
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare created_id uuid;
begin
  if not internal.is_superadmin_aal2() then
    raise exception 'superadmin_aal2_required' using errcode = '42501';
  end if;
  if target_organization_id is null or not exists (select 1 from public.organizations o where o.id = target_organization_id) then
    raise exception 'organization_not_found';
  end if;
  if target_project_id is not null and not exists (
    select 1 from public.projects p join public.workspaces w on w.id=p.workspace_id
    where p.id=target_project_id and w.organization_id=target_organization_id
  ) then
    raise exception 'project_organization_mismatch';
  end if;
  if length(trim(target_target)) < 1 or length(target_target) > 1024 then raise exception 'invalid_lab_target'; end if;
  if length(trim(target_scope)) < 1 or length(target_scope) > 4000 then raise exception 'invalid_lab_scope'; end if;
  if valid_hours < 1 or valid_hours > 720 then raise exception 'invalid_lab_validity'; end if;

  insert into internal.lab_authorizations(organization_id,project_id,target,scope,approved_by,valid_from,valid_to)
  values (target_organization_id,target_project_id,trim(target_target),trim(target_scope),auth.uid(),now(),now() + make_interval(hours => valid_hours))
  returning id into created_id;

  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (target_organization_id,auth.uid(),'lab.authorization.created','lab_authorization',created_id::text,'completed',jsonb_build_object('target',left(trim(target_target),160),'valid_hours',valid_hours));

  return created_id;
end;
$$;

create or replace function public.superadmin_control_snapshot() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not internal.is_superadmin_aal2() then
    raise exception 'superadmin_aal2_required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'counts', jsonb_build_object(
      'users', (select count(*) from auth.users),
      'organizations', (select count(*) from public.organizations),
      'workspaces', (select count(*) from public.workspaces),
      'projects', (select count(*) from public.projects),
      'runs', (select count(*) from internal.agent_runs),
      'queued_jobs', (select count(*) from internal.job_queue where status in ('queued','running','retrying')),
      'workers', (select count(*) from internal.gpu_workers),
      'skills', (select count(*) from internal.skills),
      'knowledge', (select count(*) from internal.knowledge_sources),
      'integrations', (select count(*) from internal.integration_connections),
      'policies', (select count(*) from internal.policy_sets),
      'evals', (select count(*) from internal.eval_runs)
    ),
    'users', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select u.id, u.email, coalesce(p.display_name, split_part(u.email,'@',1)) as display_name,
             coalesce(u.raw_app_meta_data ->> 'system_role','user') as system_role,
             u.created_at, u.last_sign_in_at,
             (select count(*) from public.organization_members om where om.user_id=u.id and om.status='active') as active_organizations
      from auth.users u left join public.profiles p on p.user_id=u.id
      order by u.created_at desc limit 50
    ) x),
    'organizations', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select o.id,o.name,o.slug,o.created_at,
             (select count(*) from public.organization_members om where om.organization_id=o.id and om.status='active') as active_members,
             (select count(*) from public.workspaces w where w.organization_id=o.id) as workspaces
      from public.organizations o order by o.created_at desc limit 50
    ) x),
    'model_aliases', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select ma.alias, ma.model_version_id, mv.version_key, mv.status, mv.repository, mv.revision, ma.updated_at
      from internal.model_aliases ma join internal.model_versions mv on mv.id=ma.model_version_id
      order by ma.alias
    ) x),
    'model_versions', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select mv.id,mv.version_key,mv.status,mv.repository,mv.revision,mv.context_window,mv.capabilities,
             (select ma.quantization from internal.model_artifacts ma where ma.model_version_id=mv.id order by ma.created_at desc limit 1) as quantization,
             mv.created_at
      from internal.model_versions mv order by mv.created_at desc limit 30
    ) x),
    'gpu_providers', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select gp.id,gp.key,gp.enabled,
             (select count(*) from internal.gpu_workers gw where gw.provider_id=gp.id) as workers
      from internal.gpu_providers gp order by gp.key
    ) x),
    'gpu_workers', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select gw.id,gp.key as provider,gw.external_worker_id,gw.profile,gw.state,gw.last_heartbeat_at,mv.version_key
      from internal.gpu_workers gw join internal.gpu_providers gp on gp.id=gw.provider_id
      left join internal.model_versions mv on mv.id=gw.model_version_id
      order by gw.created_at desc limit 50
    ) x),
    'skills', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select s.key,s.category,s.status,s.active_version,s.created_at from internal.skills s order by s.category,s.key limit 100
    ) x),
    'knowledge', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select ks.id,ks.scope_type,ks.source_type,ks.source_uri,ks.approval_status,ks.created_at from internal.knowledge_sources ks order by ks.created_at desc limit 50
    ) x),
    'integrations', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select ic.id,ic.organization_id,o.name as organization_name,ic.provider,ic.external_account_id,ic.status,ic.created_at
      from internal.integration_connections ic left join public.organizations o on o.id=ic.organization_id
      order by ic.created_at desc limit 50
    ) x),
    'policies', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select ps.id,ps.organization_id,o.name as organization_name,ps.key,ps.version,ps.status,ps.created_at,
             (select count(*) from internal.policy_rules pr where pr.policy_set_id=ps.id) as rules
      from internal.policy_sets ps left join public.organizations o on o.id=ps.organization_id
      order by ps.created_at desc limit 50
    ) x),
    'eval_runs', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select er.id,er.status,er.created_at,er.finished_at,mv.version_key
      from internal.eval_runs er left join internal.model_versions mv on mv.id=er.model_version_id
      order by er.created_at desc limit 30
    ) x),
    'jobs', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select jq.id,jq.queue,jq.status,jq.priority,jq.attempts,jq.maximum_attempts,jq.last_error_code,jq.created_at,jq.updated_at
      from internal.job_queue jq order by jq.created_at desc limit 40
    ) x),
    'runs', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select ar.id,ar.mode,ar.status,ar.model_alias,ar.failure_code,ar.active_skill,ar.created_at,ar.started_at,ar.finished_at
      from internal.agent_runs ar order by ar.created_at desc limit 40
    ) x),
    'usage_monthly', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select um.organization_id,o.name as organization_name,um.usage_month,um.totals
      from internal.usage_monthly um left join public.organizations o on o.id=um.organization_id
      order by um.usage_month desc limit 24
    ) x),
    'lab_authorizations', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select la.id,la.organization_id,o.name as organization_name,la.project_id,la.target,la.scope,la.valid_from,la.valid_to,la.revoked_at
      from internal.lab_authorizations la left join public.organizations o on o.id=la.organization_id
      order by la.valid_to desc limit 30
    ) x),
    'audit', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select ae.id,ae.event_type,ae.target_type,ae.target_id,ae.outcome,ae.occurred_at,ae.organization_id
      from audit.audit_events ae order by ae.occurred_at desc limit 50
    ) x),
    'errors', (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select oe.trace_id,oe.service,oe.event_name,oe.severity,oe.duration_ms,oe.occurred_at
      from internal.observability_events oe where oe.severity='error' order by oe.occurred_at desc limit 30
    ) x)
  );
end;
$$;

revoke all on function public.bootstrap_initial_superadmin(text,uuid,text) from public, anon, authenticated;
grant execute on function public.bootstrap_initial_superadmin(text,uuid,text) to service_role;

revoke all on function public.superadmin_control_snapshot(), public.superadmin_set_model_alias(text,uuid), public.superadmin_create_lab_authorization(uuid,uuid,text,text,integer) from public, anon;
grant execute on function public.superadmin_control_snapshot(), public.superadmin_set_model_alias(text,uuid), public.superadmin_create_lab_authorization(uuid,uuid,text,text,integer) to authenticated, service_role;

commit;
