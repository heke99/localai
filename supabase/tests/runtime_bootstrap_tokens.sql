do $$
declare
  consume_definition text;
  resolve_definition text;
begin
  if to_regclass('internal.runtime_bootstrap_tokens') is null then
    raise exception 'runtime bootstrap token table is missing';
  end if;
  if to_regclass('internal.runtime_provisioning_leases') is null then
    raise exception 'runtime provisioning lease table is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'internal'
      and table_name = 'runtime_bootstrap_tokens'
      and column_name = 'token_hash'
  ) then
    raise exception 'runtime bootstrap hash column is missing';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'internal'
      and table_name = 'runtime_bootstrap_tokens'
      and column_name in ('token', 'secret', 'credential')
  ) then
    raise exception 'runtime bootstrap table stores a raw credential column';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'runtime_create_bootstrap_token_hash',
        'runtime_consume_bootstrap_token',
        'runtime_acquire_provisioning_lease',
        'runtime_release_provisioning_lease'
      )
      and (
        array_to_string(coalesce(p.proconfig, array[]::text[]), ',') not like '%search_path=%'
        or array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%public%'
        or array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%$user%'
      )
  ) then
    raise exception 'runtime bootstrap/lease function has an unsafe search_path';
  end if;

  select pg_get_functiondef('public.runtime_consume_bootstrap_token(text)'::regprocedure)
    into consume_definition;
  select pg_get_functiondef('public.runtime_resolve_model_routes(text)'::regprocedure)
    into resolve_definition;

  if position('consumed_at is null' in lower(consume_definition)) = 0
     or position('expires_at > now()' in lower(consume_definition)) = 0
     or position('set consumed_at = now()' in lower(consume_definition)) = 0
     or position('for update skip locked' in lower(consume_definition)) = 0 then
    raise exception 'runtime bootstrap consumption is not single-use and expiry guarded';
  end if;

  if position('last_heartbeat_at' in lower(resolve_definition)) = 0
     or position('90 seconds' in lower(resolve_definition)) = 0 then
    raise exception 'managed ready runtime routes are not heartbeat freshness guarded';
  end if;

  if has_function_privilege('authenticated', 'public.runtime_create_bootstrap_token_hash(text,text,text,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_consume_bootstrap_token(text)', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_acquire_provisioning_lease(text,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_release_provisioning_lease(text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.runtime_consume_bootstrap_token(text)', 'execute') then
    raise exception 'runtime bootstrap/lease control RPCs are exposed outside service_role';
  end if;

  if not has_function_privilege('service_role', 'public.runtime_create_bootstrap_token_hash(text,text,text,text,text,integer)', 'execute')
     or not has_function_privilege('service_role', 'public.runtime_consume_bootstrap_token(text)', 'execute')
     or not has_function_privilege('service_role', 'public.runtime_acquire_provisioning_lease(text,text,text,integer)', 'execute')
     or not has_function_privilege('service_role', 'public.runtime_release_provisioning_lease(text,text,text)', 'execute') then
    raise exception 'service_role cannot operate runtime bootstrap/lease controls';
  end if;

  if not exists (
    select 1 from internal.gpu_providers
    where key = 'hyperstack' and enabled and provider_kind = 'managed' and priority = 200
  ) then
    raise exception 'hyperstack managed provider bootstrap is not enabled';
  end if;
end $$;
