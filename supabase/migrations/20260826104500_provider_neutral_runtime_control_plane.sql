begin;

alter table internal.gpu_providers
  add column if not exists provider_kind text not null default 'managed',
  add column if not exists priority integer not null default 100,
  add column if not exists updated_at timestamptz not null default now();

alter table internal.gpu_workers
  add column if not exists endpoint text,
  add column if not exists health_url text,
  add column if not exists region text,
  add column if not exists gpu_type text,
  add column if not exists gpu_count integer,
  add column if not exists vram_total_bytes bigint,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists last_health_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'internal.gpu_providers'::regclass
      and conname = 'gpu_providers_provider_kind_check'
  ) then
    alter table internal.gpu_providers
      add constraint gpu_providers_provider_kind_check
      check (provider_kind in ('managed', 'static'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'internal.gpu_providers'::regclass
      and conname = 'gpu_providers_priority_check'
  ) then
    alter table internal.gpu_providers
      add constraint gpu_providers_priority_check
      check (priority between 0 and 10000);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'internal.gpu_workers'::regclass
      and conname = 'gpu_workers_endpoint_check'
  ) then
    alter table internal.gpu_workers
      add constraint gpu_workers_endpoint_check
      check (endpoint is null or (char_length(endpoint) <= 2048 and endpoint ~ '^https?://[^[:space:]]+$'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'internal.gpu_workers'::regclass
      and conname = 'gpu_workers_health_url_check'
  ) then
    alter table internal.gpu_workers
      add constraint gpu_workers_health_url_check
      check (health_url is null or (char_length(health_url) <= 2048 and health_url ~ '^https?://[^[:space:]]+$'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'internal.gpu_workers'::regclass
      and conname = 'gpu_workers_gpu_count_check'
  ) then
    alter table internal.gpu_workers
      add constraint gpu_workers_gpu_count_check
      check (gpu_count is null or gpu_count between 0 and 64);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'internal.gpu_workers'::regclass
      and conname = 'gpu_workers_vram_check'
  ) then
    alter table internal.gpu_workers
      add constraint gpu_workers_vram_check
      check (vram_total_bytes is null or vram_total_bytes >= 0);
  end if;
end $$;

create table if not exists internal.model_runtime_routes (
  alias text not null references internal.model_aliases(alias) on delete cascade,
  worker_id uuid not null references internal.gpu_workers(id) on delete cascade,
  priority integer not null default 100 check (priority between 0 and 10000),
  weight numeric not null default 1 check (weight > 0 and weight <= 1000),
  enabled boolean not null default true,
  activated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (alias, worker_id)
);

create index if not exists model_runtime_routes_alias_enabled_idx
  on internal.model_runtime_routes (alias, enabled, priority, updated_at desc)
  where enabled;

create index if not exists gpu_workers_runtime_resolution_idx
  on internal.gpu_workers (provider_id, state, updated_at desc);

update internal.gpu_providers
set enabled = true,
    provider_kind = 'managed',
    priority = 100,
    updated_at = now()
where key = 'runpod';

update internal.gpu_providers
set provider_kind = 'managed',
    priority = 200,
    updated_at = now()
where key = 'hyperstack';

insert into internal.gpu_providers (key, configuration, enabled, provider_kind, priority, updated_at)
values ('generic-openai', '{}'::jsonb, true, 'static', 500, now())
on conflict (key) do update
set provider_kind = excluded.provider_kind,
    priority = excluded.priority,
    updated_at = now();

create or replace function public.runtime_enabled_providers()
returns table (
  provider_key text,
  provider_kind text,
  provider_priority integer,
  configuration jsonb
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;

  return query
  select p.key, p.provider_kind, p.priority, p.configuration
  from internal.gpu_providers p
  where p.enabled
  order by p.priority asc, p.key asc;
end;
$$;

create or replace function public.runtime_resolve_model_routes(target_alias text)
returns table (
  provider_key text,
  provider_kind text,
  provider_priority integer,
  worker_id uuid,
  external_worker_id text,
  worker_state text,
  endpoint text,
  health_url text,
  profile text,
  region text,
  gpu_type text,
  gpu_count integer,
  vram_total_bytes bigint,
  route_priority integer,
  route_weight numeric,
  last_health_at timestamptz,
  updated_at timestamptz,
  metadata jsonb
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if target_alias is null or char_length(target_alias) < 1 or char_length(target_alias) > 160 then
    raise exception 'invalid_runtime_alias';
  end if;

  return query
  select
    p.key,
    p.provider_kind,
    p.priority,
    w.id,
    w.external_worker_id,
    w.state,
    w.endpoint,
    w.health_url,
    w.profile,
    w.region,
    w.gpu_type,
    w.gpu_count,
    w.vram_total_bytes,
    r.priority,
    r.weight,
    w.last_health_at,
    w.updated_at,
    w.metadata
  from internal.model_runtime_routes r
  join internal.gpu_workers w on w.id = r.worker_id
  join internal.gpu_providers p on p.id = w.provider_id
  where r.alias = target_alias
    and r.enabled
    and p.enabled
    and w.endpoint is not null
    and w.state in ('ready', 'warming', 'provisioning')
  order by
    case w.state when 'ready' then 0 when 'warming' then 1 else 2 end,
    r.priority asc,
    p.priority asc,
    w.last_health_at desc nulls last,
    w.updated_at desc;
end;
$$;

create or replace function public.runtime_register_worker(
  target_provider_key text,
  target_provider_kind text,
  target_provider_priority integer,
  target_external_worker_id text,
  target_profile text,
  target_state text,
  target_model_alias text,
  target_endpoint text,
  target_health_url text default null,
  target_region text default null,
  target_gpu_type text default null,
  target_gpu_count integer default null,
  target_vram_total_bytes bigint default null,
  target_route_priority integer default 100,
  target_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_provider_id uuid;
  resolved_model_version_id uuid;
  resolved_worker_id uuid;
  provider_enabled boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if target_provider_key is null or target_provider_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid_runtime_provider_key';
  end if;
  if target_provider_kind not in ('managed', 'static') then
    raise exception 'invalid_runtime_provider_kind';
  end if;
  if target_provider_priority is null or target_provider_priority not between 0 and 10000 then
    raise exception 'invalid_runtime_provider_priority';
  end if;
  if target_external_worker_id is null or char_length(target_external_worker_id) < 1 or char_length(target_external_worker_id) > 512 then
    raise exception 'invalid_runtime_external_id';
  end if;
  if target_profile is null or char_length(target_profile) < 1 or char_length(target_profile) > 160 then
    raise exception 'invalid_runtime_profile';
  end if;
  if target_state not in ('provisioning', 'warming', 'ready', 'draining', 'stopped', 'failed') then
    raise exception 'invalid_runtime_state';
  end if;
  if target_model_alias is null or char_length(target_model_alias) < 1 or char_length(target_model_alias) > 160 then
    raise exception 'invalid_runtime_alias';
  end if;
  if target_endpoint is null or char_length(target_endpoint) > 2048 or target_endpoint !~ '^https?://[^[:space:]]+$' then
    raise exception 'invalid_runtime_endpoint';
  end if;
  if target_health_url is not null and (char_length(target_health_url) > 2048 or target_health_url !~ '^https?://[^[:space:]]+$') then
    raise exception 'invalid_runtime_health_url';
  end if;
  if target_gpu_count is not null and target_gpu_count not between 0 and 64 then
    raise exception 'invalid_runtime_gpu_count';
  end if;
  if target_vram_total_bytes is not null and target_vram_total_bytes < 0 then
    raise exception 'invalid_runtime_vram';
  end if;
  if target_route_priority is null or target_route_priority not between 0 and 10000 then
    raise exception 'invalid_runtime_route_priority';
  end if;
  if jsonb_typeof(coalesce(target_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_runtime_metadata';
  end if;

  select ma.model_version_id
  into resolved_model_version_id
  from internal.model_aliases ma
  where ma.alias = target_model_alias;
  if resolved_model_version_id is null then
    raise exception 'runtime_model_alias_not_found';
  end if;

  insert into internal.gpu_providers (key, configuration, enabled, provider_kind, priority, updated_at)
  values (target_provider_key, '{}'::jsonb, true, target_provider_kind, target_provider_priority, now())
  on conflict (key) do nothing;

  select p.id, p.enabled
  into resolved_provider_id, provider_enabled
  from internal.gpu_providers p
  where p.key = target_provider_key
  for update;

  if resolved_provider_id is null then
    raise exception 'runtime_provider_not_found';
  end if;
  if not provider_enabled then
    raise exception 'runtime_provider_disabled';
  end if;

  insert into internal.gpu_workers (
    provider_id,
    external_worker_id,
    profile,
    state,
    model_version_id,
    endpoint,
    health_url,
    region,
    gpu_type,
    gpu_count,
    vram_total_bytes,
    metadata,
    last_health_at,
    last_error_code,
    updated_at
  ) values (
    resolved_provider_id,
    target_external_worker_id,
    target_profile,
    target_state,
    resolved_model_version_id,
    target_endpoint,
    target_health_url,
    nullif(target_region, ''),
    nullif(target_gpu_type, ''),
    target_gpu_count,
    target_vram_total_bytes,
    coalesce(target_metadata, '{}'::jsonb),
    case when target_state = 'ready' then now() else null end,
    null,
    now()
  )
  on conflict (provider_id, external_worker_id) do update
  set profile = excluded.profile,
      state = excluded.state,
      model_version_id = excluded.model_version_id,
      endpoint = excluded.endpoint,
      health_url = excluded.health_url,
      region = excluded.region,
      gpu_type = excluded.gpu_type,
      gpu_count = excluded.gpu_count,
      vram_total_bytes = excluded.vram_total_bytes,
      metadata = excluded.metadata,
      last_health_at = case when excluded.state = 'ready' then now() else internal.gpu_workers.last_health_at end,
      last_error_code = null,
      updated_at = now()
  returning id into resolved_worker_id;

  insert into internal.model_runtime_routes (alias, worker_id, priority, weight, enabled, activated_at, updated_at)
  values (target_model_alias, resolved_worker_id, target_route_priority, 1, true, now(), now())
  on conflict (alias, worker_id) do update
  set priority = excluded.priority,
      enabled = true,
      activated_at = case when internal.model_runtime_routes.enabled then internal.model_runtime_routes.activated_at else now() end,
      updated_at = now();

  return resolved_worker_id;
end;
$$;

create or replace function public.runtime_mark_worker_health(
  target_provider_key text,
  target_external_worker_id text,
  target_state text,
  target_last_error_code text default null,
  target_metadata jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_rows integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if target_state not in ('provisioning', 'warming', 'ready', 'draining', 'stopped', 'failed') then
    raise exception 'invalid_runtime_state';
  end if;
  if target_last_error_code is not null and char_length(target_last_error_code) > 160 then
    raise exception 'invalid_runtime_error_code';
  end if;
  if target_metadata is not null and jsonb_typeof(target_metadata) <> 'object' then
    raise exception 'invalid_runtime_metadata';
  end if;

  update internal.gpu_workers w
  set state = target_state,
      last_health_at = case when target_state = 'ready' then now() else w.last_health_at end,
      last_error_code = case when target_state = 'ready' then null else nullif(target_last_error_code, '') end,
      metadata = case when target_metadata is null then w.metadata else w.metadata || target_metadata end,
      updated_at = now()
  from internal.gpu_providers p
  where p.id = w.provider_id
    and p.key = target_provider_key
    and w.external_worker_id = target_external_worker_id;

  get diagnostics changed_rows = row_count;
  return changed_rows = 1;
end;
$$;

revoke all on function public.runtime_enabled_providers() from public, anon, authenticated;
revoke all on function public.runtime_resolve_model_routes(text) from public, anon, authenticated;
revoke all on function public.runtime_register_worker(text,text,integer,text,text,text,text,text,text,text,text,integer,bigint,integer,jsonb) from public, anon, authenticated;
revoke all on function public.runtime_mark_worker_health(text,text,text,text,jsonb) from public, anon, authenticated;

grant execute on function public.runtime_enabled_providers() to service_role;
grant execute on function public.runtime_resolve_model_routes(text) to service_role;
grant execute on function public.runtime_register_worker(text,text,integer,text,text,text,text,text,text,text,text,integer,bigint,integer,jsonb) to service_role;
grant execute on function public.runtime_mark_worker_health(text,text,text,text,jsonb) to service_role;

commit;
