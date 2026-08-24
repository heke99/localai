do $$
declare
  invalid_connected integer;
  invalid_capabilities integer;
begin
  select count(*) into invalid_connected
  from internal.integration_connections
  where provider = 'vercel'
    and status in ('connected', 'active', 'ready')
    and coalesce(metadata ->> 'accessModel', '') <> 'vercel_integration_installation';

  if invalid_connected <> 0 then
    raise exception 'identity-only Vercel connections must not be marked connected: %', invalid_connected;
  end if;

  select count(*) into invalid_capabilities
  from internal.integration_capabilities c
  join internal.integration_connections ic on ic.id = c.connection_id
  where ic.provider = 'vercel'
    and ic.status = 'pending'
    and ic.last_error_code = 'vercel_project_access_required'
    and c.granted;

  if invalid_capabilities <> 0 then
    raise exception 'incomplete Vercel connections retain granted capabilities: %', invalid_capabilities;
  end if;

  if to_regclass('internal.vercel_webhook_events') is null then
    raise exception 'Vercel webhook event table is missing';
  end if;

  if has_function_privilege('anon','public.service_find_vercel_connections_for_webhook(text,text,text)','execute')
     or has_function_privilege('authenticated','public.service_find_vercel_connections_for_webhook(text,text,text)','execute') then
    raise exception 'Vercel webhook connection lookup is exposed to clients';
  end if;

  if has_function_privilege('anon','public.service_record_vercel_webhook_event(uuid,text,text,timestamptz,text,text,text,text,text,jsonb)','execute')
     or has_function_privilege('authenticated','public.service_record_vercel_webhook_event(uuid,text,text,timestamptz,text,text,text,text,text,jsonb)','execute') then
    raise exception 'Vercel webhook event writer is exposed to clients';
  end if;

  if not has_function_privilege('service_role','public.service_find_vercel_connections_for_webhook(text,text,text)','execute')
     or not has_function_privilege('service_role','public.service_record_vercel_webhook_event(uuid,text,text,timestamptz,text,text,text,text,text,jsonb)','execute') then
    raise exception 'service_role cannot process Vercel webhooks';
  end if;
end $$;
