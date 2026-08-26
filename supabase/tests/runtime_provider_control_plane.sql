do $$
declare
  register_definition text;
  resolve_definition text;
  normalized_register text;
  normalized_resolve text;
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

  normalized_register := regexp_replace(lower(register_definition), '\s+', '', 'g');
  normalized_resolve := regexp_replace(lower(resolve_definition), '\s+', '', 'g');

  if position('setsearch_path=''''::text' in normalized_register) = 0
     and position('setsearch_pathto''''::text' in normalized_register) = 0
     and position('setsearch_path=''''' in normalized_register) = 0 then
    raise exception 'runtime register function does not pin an empty search_path';
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
