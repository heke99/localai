begin;

create table if not exists internal.runtime_provisioning_leases (
  alias text not null references internal.model_aliases(alias) on delete cascade,
  provider_key text not null references internal.gpu_providers(key) on delete cascade,
  holder_id text not null check (char_length(holder_id) between 1 and 160),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (alias, provider_key)
);

create index if not exists runtime_provisioning_leases_expiry_idx
  on internal.runtime_provisioning_leases (expires_at);

revoke all on table internal.runtime_provisioning_leases from public, anon, authenticated;
grant select, insert, update, delete on table internal.runtime_provisioning_leases to service_role;

create or replace function public.runtime_acquire_provisioning_lease(
  target_alias text,
  target_provider_key text,
  target_holder_id text,
  target_ttl_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if target_alias is null or char_length(target_alias) not between 1 and 160 then
    raise exception 'invalid_runtime_alias';
  end if;
  if target_provider_key is null or target_provider_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid_runtime_provider_key';
  end if;
  if target_holder_id is null or char_length(target_holder_id) not between 1 and 160 then
    raise exception 'invalid_runtime_lease_holder';
  end if;
  if target_ttl_seconds is null or target_ttl_seconds not between 15 and 900 then
    raise exception 'invalid_runtime_lease_ttl';
  end if;
  if not exists (select 1 from internal.model_aliases a where a.alias = target_alias) then
    raise exception 'runtime_model_alias_not_found';
  end if;
  if not exists (select 1 from internal.gpu_providers p where p.key = target_provider_key and p.enabled) then
    raise exception 'runtime_provider_disabled';
  end if;

  insert into internal.runtime_provisioning_leases (
    alias,
    provider_key,
    holder_id,
    expires_at,
    created_at,
    updated_at
  ) values (
    target_alias,
    target_provider_key,
    target_holder_id,
    now() + make_interval(secs => target_ttl_seconds),
    now(),
    now()
  )
  on conflict (alias, provider_key) do update
  set holder_id = excluded.holder_id,
      expires_at = excluded.expires_at,
      updated_at = now()
  where internal.runtime_provisioning_leases.expires_at <= now()
     or internal.runtime_provisioning_leases.holder_id = excluded.holder_id
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function public.runtime_release_provisioning_lease(
  target_alias text,
  target_provider_key text,
  target_holder_id text
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
  if target_alias is null or char_length(target_alias) not between 1 and 160
     or target_provider_key is null or target_provider_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or target_holder_id is null or char_length(target_holder_id) not between 1 and 160 then
    return false;
  end if;

  delete from internal.runtime_provisioning_leases
  where alias = target_alias
    and provider_key = target_provider_key
    and holder_id = target_holder_id;
  get diagnostics changed_rows = row_count;
  return changed_rows = 1;
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
    and (
      w.state <> 'ready'
      or p.provider_kind = 'static'
      or w.last_heartbeat_at >= now() - interval '45 seconds'
    )
  order by
    case w.state when 'ready' then 0 when 'warming' then 1 else 2 end,
    r.priority asc,
    p.priority asc,
    w.last_heartbeat_at desc nulls last,
    w.last_health_at desc nulls last,
    w.updated_at desc;
end;
$$;

revoke all on function public.runtime_acquire_provisioning_lease(text,text,text,integer) from public, anon, authenticated;
revoke all on function public.runtime_release_provisioning_lease(text,text,text) from public, anon, authenticated;
grant execute on function public.runtime_acquire_provisioning_lease(text,text,text,integer) to service_role;
grant execute on function public.runtime_release_provisioning_lease(text,text,text) to service_role;

commit;
