do $$
declare
  acquire_definition text;
  release_definition text;
  resolve_definition text;
begin
  select pg_get_functiondef('public.runtime_acquire_provisioning_lease(text,text,text,integer)'::regprocedure)
    into acquire_definition;
  select pg_get_functiondef('public.runtime_release_provisioning_lease(text,text,text)'::regprocedure)
    into release_definition;
  select pg_get_functiondef('public.runtime_resolve_model_routes(text)'::regprocedure)
    into resolve_definition;

  if position('on conflict (alias, provider_key) do update' in lower(acquire_definition)) = 0
     or position('expires_at <= now()' in lower(acquire_definition)) = 0
     or position('holder_id = excluded.holder_id' in lower(acquire_definition)) = 0 then
    raise exception 'runtime provisioning lease is not atomic/renewable';
  end if;

  if position('holder_id = target_holder_id' in lower(release_definition)) = 0 then
    raise exception 'runtime provisioning lease release does not enforce ownership';
  end if;

  if position('last_heartbeat_at' in lower(resolve_definition)) = 0
     or position('90 seconds' in lower(resolve_definition)) = 0
     or position('provider_kind = ''static''' in lower(resolve_definition)) <> 0
     or position('w.state = ''ready''' in lower(resolve_definition)) = 0 then
    raise exception 'runtime route freshness policy is incomplete';
  end if;

  if has_function_privilege('authenticated', 'public.runtime_acquire_provisioning_lease(text,text,text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.runtime_release_provisioning_lease(text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.runtime_acquire_provisioning_lease(text,text,text,integer)', 'execute') then
    raise exception 'runtime provisioning lease controls are exposed to untrusted roles';
  end if;
end $$;
