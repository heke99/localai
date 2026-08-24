begin;

create table if not exists internal.agent_platform_exports (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  bundle_hash text not null check (bundle_hash ~ '^[a-f0-9]{64}$'),
  schema_version integer not null check (schema_version = 1),
  platform_version text not null,
  runtime_version text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  configuration_references jsonb not null default '[]'::jsonb check (jsonb_typeof(configuration_references) = 'array'),
  selected_project_ids uuid[] not null default '{}',
  selected_repository_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists agent_platform_exports_created_idx on internal.agent_platform_exports(created_at desc);

create table if not exists internal.agent_platform_imports (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  activated_by uuid references auth.users(id),
  bundle_hash text not null check (bundle_hash ~ '^[a-f0-9]{64}$'),
  schema_version integer not null check (schema_version = 1),
  platform_version text not null,
  runtime_version text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  configuration_references jsonb not null default '[]'::jsonb check (jsonb_typeof(configuration_references) = 'array'),
  selected_project_ids uuid[] not null default '{}',
  selected_repository_ids uuid[] not null default '{}',
  validation jsonb not null check (jsonb_typeof(validation) = 'object'),
  self_tests jsonb not null default '[]'::jsonb check (jsonb_typeof(self_tests) = 'array'),
  status text not null check (status in ('blocked','ready','activated','superseded')),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
create index if not exists agent_platform_imports_created_idx on internal.agent_platform_imports(created_at desc);
create unique index if not exists agent_platform_one_active_import_idx on internal.agent_platform_imports ((1)) where status='activated';

alter table internal.agent_platform_exports enable row level security;
alter table internal.agent_platform_imports enable row level security;
revoke all on table internal.agent_platform_exports, internal.agent_platform_imports from public,anon,authenticated;
grant all on table internal.agent_platform_exports, internal.agent_platform_imports to service_role;

create or replace function public.superadmin_portability_source()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare target_model_id uuid;
begin
  if not internal.is_superadmin_email_verified() then raise exception 'superadmin_step_up_required' using errcode='42501'; end if;
  select ma.model_version_id into target_model_id from internal.model_aliases ma where ma.alias='general-prod';
  return jsonb_build_object(
    'model',(select to_jsonb(x) from (
      select mv.id,mv.version_key,mv.repository,mv.revision,mv.capabilities,
             (select ma.quantization from internal.model_artifacts ma where ma.model_version_id=mv.id order by ma.quantization asc,ma.filename asc limit 1) quantization
      from internal.model_versions mv where mv.id=target_model_id
    ) x),
    'knowledge',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select ks.id,ks.scope_type,ks.scope_id,ks.source_uri,ks.content_hash,ks.created_at
      from internal.knowledge_sources ks
      where ks.approval_status='approved' and ks.scope_type in ('GLOBAL','ORGANIZATION')
      order by ks.created_at desc limit 500
    ) x),'[]'::jsonb),
    'model_health',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select mh.ok,mh.latency_ms,mh.observed_at,md.environment
      from internal.model_health_checks mh join internal.model_deployments md on md.id=mh.model_deployment_id
      where md.model_version_id=target_model_id
      order by mh.observed_at desc limit 10
    ) x),'[]'::jsonb),
    'evals',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select er.id,er.status::text status,er.created_at,er.finished_at,es.key suite_key,es.version suite_version
      from internal.eval_runs er join internal.eval_suites es on es.id=er.suite_id
      where er.model_version_id=target_model_id
      order by er.created_at desc limit 20
    ) x),'[]'::jsonb),
    'recent_imports',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select i.id,i.bundle_hash,i.status,i.created_at,i.activated_at from internal.agent_platform_imports i order by i.created_at desc limit 20
    ) x),'[]'::jsonb),
    'recent_exports',coalesce((select jsonb_agg(to_jsonb(x)) from (
      select e.id,e.bundle_hash,e.created_at from internal.agent_platform_exports e order by e.created_at desc limit 20
    ) x),'[]'::jsonb)
  );
end $$;
revoke all on function public.superadmin_portability_source() from public,anon;
grant execute on function public.superadmin_portability_source() to authenticated;

create or replace function public.superadmin_record_platform_export(
  target_bundle_hash text,target_manifest jsonb,target_configuration_references jsonb,
  target_selected_project_ids uuid[] default '{}',target_selected_repository_ids uuid[] default '{}'
) returns uuid language plpgsql security definer set search_path=''
as $$ declare created_id uuid;
begin
  if not internal.is_superadmin_email_verified() then raise exception 'superadmin_step_up_required' using errcode='42501'; end if;
  if target_bundle_hash !~ '^[a-f0-9]{64}$' or coalesce((target_manifest->>'schemaVersion')::integer,0) <> 1 then raise exception 'invalid_portability_export'; end if;
  if jsonb_typeof(coalesce(target_configuration_references,'[]'::jsonb)) <> 'array' then raise exception 'invalid_configuration_references'; end if;
  insert into internal.agent_platform_exports(created_by,bundle_hash,schema_version,platform_version,runtime_version,manifest,configuration_references,selected_project_ids,selected_repository_ids)
  values(auth.uid(),target_bundle_hash,1,target_manifest->>'platformVersion',target_manifest->>'runtimeVersion',target_manifest,coalesce(target_configuration_references,'[]'::jsonb),coalesce(target_selected_project_ids,'{}'),coalesce(target_selected_repository_ids,'{}'))
  returning id into created_id;
  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values(auth.uid(),'agent.platform.exported','agent_platform_export',created_id::text,'completed',jsonb_build_object('bundle_hash',target_bundle_hash));
  return created_id;
end $$;
revoke all on function public.superadmin_record_platform_export(text,jsonb,jsonb,uuid[],uuid[]) from public,anon;
grant execute on function public.superadmin_record_platform_export(text,jsonb,jsonb,uuid[],uuid[]) to authenticated;

create or replace function public.superadmin_record_platform_import(
  target_bundle_hash text,target_manifest jsonb,target_configuration_references jsonb,
  target_selected_project_ids uuid[],target_selected_repository_ids uuid[],target_validation jsonb,target_self_tests jsonb
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare created_id uuid; target_status text; required_test text; all_tests_passed boolean := true;
begin
  if not internal.is_superadmin_email_verified() then raise exception 'superadmin_step_up_required' using errcode='42501'; end if;
  if target_bundle_hash !~ '^[a-f0-9]{64}$' or coalesce((target_manifest->>'schemaVersion')::integer,0) <> 1 then raise exception 'invalid_portability_import'; end if;
  if jsonb_typeof(coalesce(target_validation,'{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(target_self_tests,'[]'::jsonb)) <> 'array' then raise exception 'invalid_portability_evidence'; end if;
  foreach required_test in array array['provider-health','model-health','tool-contracts','skill-resolution','baseline-evals','portability-eval'] loop
    if not exists(select 1 from jsonb_array_elements(coalesce(target_self_tests,'[]'::jsonb)) item where item->>'kind'=required_test and item->>'status'='passed') then all_tests_passed := false; end if;
  end loop;
  target_status := case when coalesce((target_validation->>'compatible')::boolean,false) and all_tests_passed then 'ready' else 'blocked' end;
  insert into internal.agent_platform_imports(created_by,bundle_hash,schema_version,platform_version,runtime_version,manifest,configuration_references,selected_project_ids,selected_repository_ids,validation,self_tests,status)
  values(auth.uid(),target_bundle_hash,1,target_manifest->>'platformVersion',target_manifest->>'runtimeVersion',target_manifest,coalesce(target_configuration_references,'[]'::jsonb),coalesce(target_selected_project_ids,'{}'),coalesce(target_selected_repository_ids,'{}'),target_validation,target_self_tests,target_status)
  returning id into created_id;
  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values(auth.uid(),'agent.platform.import.staged','agent_platform_import',created_id::text,target_status,jsonb_build_object('bundle_hash',target_bundle_hash,'status',target_status));
  return jsonb_build_object('id',created_id,'status',target_status);
end $$;
revoke all on function public.superadmin_record_platform_import(text,jsonb,jsonb,uuid[],uuid[],jsonb,jsonb) from public,anon;
grant execute on function public.superadmin_record_platform_import(text,jsonb,jsonb,uuid[],uuid[],jsonb,jsonb) to authenticated;

create or replace function public.superadmin_activate_platform_import(target_import_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$ declare target internal.agent_platform_imports%rowtype;
begin
  if not internal.is_superadmin_email_verified() then raise exception 'superadmin_step_up_required' using errcode='42501'; end if;
  select * into target from internal.agent_platform_imports where id=target_import_id for update;
  if not found then raise exception 'platform_import_not_found'; end if;
  if target.status <> 'ready' then raise exception 'platform_import_not_ready'; end if;
  update internal.agent_platform_imports set status='superseded' where status='activated';
  update internal.agent_platform_imports set status='activated',activated_by=auth.uid(),activated_at=now() where id=target_import_id;
  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values(auth.uid(),'agent.platform.import.activated','agent_platform_import',target_import_id::text,'completed',jsonb_build_object('bundle_hash',target.bundle_hash));
  return jsonb_build_object('id',target_import_id,'status','activated','bundle_hash',target.bundle_hash);
end $$;
revoke all on function public.superadmin_activate_platform_import(uuid) from public,anon;
grant execute on function public.superadmin_activate_platform_import(uuid) to authenticated;

create or replace function public.superadmin_platform_import_status(target_import_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  select case when internal.is_superadmin_email_verified() then (
    select jsonb_build_object('id',i.id,'bundle_hash',i.bundle_hash,'status',i.status,'validation',i.validation,'self_tests',i.self_tests,'created_at',i.created_at,'activated_at',i.activated_at)
    from internal.agent_platform_imports i where i.id=target_import_id
  ) else null end
$$;
revoke all on function public.superadmin_platform_import_status(uuid) from public,anon;
grant execute on function public.superadmin_platform_import_status(uuid) to authenticated;

commit;
