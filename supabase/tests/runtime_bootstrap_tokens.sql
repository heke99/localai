do $$
declare
  issue_definition text;
  consume_definition text;
begin
  if to_regclass('internal.runtime_bootstrap_tokens') is null then
    raise exception 'runtime bootstrap token table is missing';
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

  select pg_get_functiondef('public.runtime_create_bootstrap_token_hash(text,text,text,text,text,integer)'::regprocedure)
    into issue_definition;
  select pg_get_functiondef('public.runtime_consume_bootstrap_token(text)'::regprocedure)
    into consume_definition;

  if position('set search_path = ''''' in lower(issue_definition)) = 0
     and position('set search_path to ''''' in lower(issue_definition)) = 0 then
    raise exception 'runtime bootstrap issuer does not pin empty search_path';
  end if;

  if position('consumed_at is null' in lower(consume_definition)) = 0
     or position('expires_at > now()' in lower(consume_definition)) = 0
     or position('set consumed_at = now()' in lower(consume_definition)) = 0
     or position('for update skip locked' in lower(consume_definition)) = 0 then
    raise exception 'runtime bootstrap consumption is not single-use and expiry guarded';
  end if;

  if has_function_privilege('authenticated', 'public.runtime_create_bootstrap_token_hash(text,text,text,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_consume_bootstrap_token(text)', 'execute')
     or has_function_privilege('anon', 'public.runtime_consume_bootstrap_token(text)', 'execute') then
    raise exception 'runtime bootstrap control RPCs are exposed outside service_role';
  end if;

  if not has_function_privilege('service_role', 'public.runtime_create_bootstrap_token_hash(text,text,text,text,text,integer)', 'execute')
     or not has_function_privilege('service_role', 'public.runtime_consume_bootstrap_token(text)', 'execute') then
    raise exception 'service_role cannot operate runtime bootstrap credentials';
  end if;

  if not exists (
    select 1 from internal.gpu_providers
    where key = 'hyperstack' and enabled and provider_kind = 'managed' and priority = 200
  ) then
    raise exception 'hyperstack managed provider bootstrap is not enabled';
  end if;
end $$;
