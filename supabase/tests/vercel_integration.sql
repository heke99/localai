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
end $$;
