begin;

create or replace function public.runtime_worker_heartbeat(
  target_provider_key text,
  target_external_worker_id text,
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
  if target_provider_key is null or target_provider_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid_runtime_provider_key';
  end if;
  if target_external_worker_id is null or char_length(target_external_worker_id) < 1 or char_length(target_external_worker_id) > 512 then
    raise exception 'invalid_runtime_external_id';
  end if;
  if target_metadata is not null and jsonb_typeof(target_metadata) <> 'object' then
    raise exception 'invalid_runtime_metadata';
  end if;

  update internal.gpu_workers w
  set state = 'ready',
      last_heartbeat_at = now(),
      last_health_at = now(),
      last_error_code = null,
      metadata = case when target_metadata is null then w.metadata else w.metadata || target_metadata end,
      updated_at = now()
  from internal.gpu_providers p
  where p.id = w.provider_id
    and p.enabled
    and p.key = target_provider_key
    and w.external_worker_id = target_external_worker_id;

  get diagnostics changed_rows = row_count;
  return changed_rows = 1;
end;
$$;

revoke all on function public.runtime_worker_heartbeat(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.runtime_worker_heartbeat(text,text,jsonb) to service_role;

commit;
