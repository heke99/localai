do $$
declare
  register_definition text;
  resolve_definition text;
begin
  if to_regclass('internal.model_runtime_routes') is null then
    raise exception 'model runtime route registry is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'internal' and table_name = 'gpu_workers' and column_name = 'endpoint'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'internal' and table_name = 'gpu_workers' and column_name = 'health_url'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'internal' and table_name = 'gpu_workers' and column_name = 'metadata'
  ) then
    raise exception 'gpu worker runtime routing columns are incomplete';
  end if;

  select pg_get_functiondef('public.runtime_register_worker(text,text,integer,text,text,text,text,text,text,text,text,integer,bigint,integer,jsonb)'::regprocedure)
    into register_definition;
  select pg_get_functiondef('public.runtime_resolve_model_routes(text)'::regprocedure)
    into resolve_definition;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('runtime_register_worker', 'runtime_resolve_model_routes', 'runtime_enabled_providers', 'runtime_mark_worker_health')
      and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%'
  ) then
    raise exception 'runtime control functions do not pin search_path';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('runtime_register_worker', 'runtime_resolve_model_routes', 'runtime_enabled_providers', 'runtime_mark_worker_health')
      and (
        array_to_string(coalesce(p.proconfig, array[]::text[]), ',') not like '%search_path=%'
        or array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%public%'
        or array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%$user%'
      )
  ) then
    raise exception 'runtime control function has an unsafe search_path';
  end if;

  if position('internal.model_aliases' in lower(register_definition)) = 0
     or position('internal.model_runtime_routes' in lower(register_definition)) = 0
     or position('internal.gpu_workers' in lower(register_definition)) = 0 then
    raise exception 'runtime registration is not bound to the canonical model/worker registry';
  end if;

  if position('internal.model_runtime_routes' in lower(resolve_definition)) = 0
     or position('internal.gpu_providers' in lower(resolve_definition)) = 0
     or position('p.enabled' in lower(resolve_definition)) = 0 then
    raise exception 'runtime resolution does not honor provider registry state';
  end if;

  if has_function_privilege('authenticated', 'public.runtime_enabled_providers()', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_resolve_model_routes(text)', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_register_worker(text,text,integer,text,text,text,text,text,text,text,text,integer,bigint,integer,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_mark_worker_health(text,text,text,text,jsonb)', 'execute') then
    raise exception 'authenticated users can invoke service-role runtime control RPCs';
  end if;

  if has_function_privilege('anon', 'public.runtime_resolve_model_routes(text)', 'execute')
     or has_function_privilege('anon', 'public.runtime_register_worker(text,text,integer,text,text,text,text,text,text,text,text,integer,bigint,integer,jsonb)', 'execute') then
    raise exception 'anon can access runtime control RPCs';
  end if;

  if not has_function_privilege('service_role', 'public.runtime_enabled_providers()', 'execute')
     or not has_function_privilege('service_role', 'public.runtime_resolve_model_routes(text)', 'execute')
     or not has_function_privilege('service_role', 'public.runtime_register_worker(text,text,integer,text,text,text,text,text,text,text,text,integer,bigint,integer,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.runtime_mark_worker_health(text,text,text,text,jsonb)', 'execute') then
    raise exception 'service_role cannot operate runtime control plane';
  end if;

  if not exists (select 1 from internal.gpu_providers where key = 'runpod' and enabled and provider_kind = 'managed') then
    raise exception 'runpod provider is not enabled as managed runtime adapter';
  end if;

  if not exists (select 1 from internal.gpu_providers where key = 'generic-openai' and enabled and provider_kind = 'static') then
    raise exception 'generic OpenAI-compatible provider bootstrap is missing';
  end if;
end $$;
