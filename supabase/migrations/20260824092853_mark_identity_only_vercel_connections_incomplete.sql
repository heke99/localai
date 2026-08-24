begin;

-- Older builds used Sign in with Vercel identity OAuth for a resource
-- integration. Those tokens can identify the account but do not prove a
-- Vercel Integration installation or project scope. Do not present them as a
-- fully connected project integration.
update internal.integration_connections
set
  status = 'pending',
  last_error_code = 'vercel_project_access_required'
where provider = 'vercel'
  and status in ('connected', 'active', 'ready')
  and coalesce(metadata ->> 'accessModel', '') <> 'vercel_integration_installation';

update internal.integration_capabilities c
set granted = false
where exists (
  select 1
  from internal.integration_connections ic
  where ic.id = c.connection_id
    and ic.provider = 'vercel'
    and ic.status = 'pending'
    and ic.last_error_code = 'vercel_project_access_required'
);

commit;
