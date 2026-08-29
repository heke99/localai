begin;

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
    and w.state = 'ready'
    and w.last_heartbeat_at is not null
    and w.last_heartbeat_at >= now() - interval '90 seconds'
  order by
    r.priority asc,
    p.priority asc,
    w.last_heartbeat_at desc,
    w.last_health_at desc nulls last,
    w.updated_at desc;
end;
$$;

create or replace function public.runtime_reap_stale_workers(target_stale_seconds integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_rows integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if target_stale_seconds is null or target_stale_seconds not between 30 and 900 then
    raise exception 'invalid_runtime_stale_seconds';
  end if;

  update internal.gpu_workers
  set state = 'failed',
      last_error_code = 'heartbeat_stale',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'failedBy', 'runtime-stale-reaper',
        'staleHeartbeatAt', last_heartbeat_at
      ),
      updated_at = now()
  where state in ('ready', 'warming', 'provisioning')
    and (
      last_heartbeat_at is null
      or last_heartbeat_at < now() - make_interval(secs => target_stale_seconds)
    );

  get diagnostics changed_rows = row_count;
  return changed_rows;
end;
$$;

revoke all on function public.runtime_reap_stale_workers(integer) from public, anon, authenticated;
grant execute on function public.runtime_reap_stale_workers(integer) to service_role;

commit;
