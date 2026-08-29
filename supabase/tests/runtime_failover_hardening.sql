do $$
declare
  route_def text;
begin
  if not has_function_privilege('service_role','public.runtime_reap_stale_workers(integer)','EXECUTE') then
    raise exception 'service_role must execute runtime stale reaper';
  end if;
  if has_function_privilege('authenticated','public.runtime_reap_stale_workers(integer)','EXECUTE')
     or has_function_privilege('anon','public.runtime_reap_stale_workers(integer)','EXECUTE') then
    raise exception 'client roles must not execute runtime stale reaper';
  end if;

  select pg_get_functiondef(p.oid) into route_def
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='runtime_resolve_model_routes'
  order by p.oid desc limit 1;

  if route_def is null then raise exception 'runtime route resolver missing'; end if;
  if route_def not like '%w.state = ''ready''%' then
    raise exception 'runtime resolver must route ready workers only';
  end if;
  if route_def not like '%w.last_heartbeat_at IS NOT NULL%'
     or route_def not like '%w.last_heartbeat_at >=%'
     or (route_def not like '%00:01:30%' and route_def not like '%90 seconds%') then
    raise exception 'runtime resolver must require fresh 90 second heartbeat for all providers';
  end if;
  if route_def like '%provider_kind = ''static''%' then
    raise exception 'static providers must not bypass heartbeat freshness';
  end if;
end $$;
