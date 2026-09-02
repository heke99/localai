begin;

-- Security testing is represented by the same canonical project/resource graph as
-- GitHub, Supabase and Vercel. The model never gets network authority from text in
-- the prompt; it only receives a security_scope resource explicitly configured by
-- an authorized project member.
insert into internal.integration_capability_catalog(provider, capability, label, risk, resource_type, description) values
  ('security', 'security.passive', 'Passive security checks', 'read', 'security_scope', 'Bounded HTTP, TLS and DNS checks against explicitly authorized targets'),
  ('security', 'security.active', 'Active security checks', 'sensitive', 'security_scope', 'Bounded active security checks against explicitly authorized targets')
on conflict (provider, capability) do update
set label = excluded.label,
    risk = excluded.risk,
    resource_type = excluded.resource_type,
    description = excluded.description;

create or replace function public.configure_project_security_scope(
  target_project_id uuid,
  target_allow_hosts text[] default '{}'::text[],
  target_allow_ipv4_cidrs text[] default '{}'::text[],
  target_active boolean default false,
  target_authorized boolean default false,
  target_authorization_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  workspace_id uuid;
  org_id uuid;
  project_mode text;
  security_connection_id uuid;
  security_resource_id uuid;
  raw_host text;
  normalized_host text;
  raw_cidr text;
  normalized_hosts text[] := '{}'::text[];
  normalized_cidrs text[] := '{}'::text[];
  capabilities text[] := array['security.passive'];
  result_capabilities jsonb;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select p.workspace_id, w.organization_id, p.mode
  into workspace_id, org_id, project_mode
  from public.projects p
  join public.workspaces w on w.id = p.workspace_id
  where p.id = target_project_id
    and internal.is_workspace_member(p.workspace_id);

  if org_id is null then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;
  if project_mode <> 'lab' then
    raise exception 'security_scope_requires_lab_project';
  end if;
  if not internal.has_permission(org_id, 'project.write') or not internal.has_permission(org_id, 'lab.run') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if target_authorized is not true then
    raise exception 'security_scope_authorization_required' using errcode = '42501';
  end if;
  if char_length(coalesce(target_authorization_note, '')) > 500 then
    raise exception 'security_scope_authorization_note_too_long';
  end if;
  if cardinality(coalesce(target_allow_hosts, '{}'::text[])) > 20
     or cardinality(coalesce(target_allow_ipv4_cidrs, '{}'::text[])) > 20 then
    raise exception 'security_scope_too_large';
  end if;

  foreach raw_host in array coalesce(target_allow_hosts, '{}'::text[]) loop
    normalized_host := lower(trim(trailing '.' from trim(raw_host)));
    if normalized_host = '' then
      continue;
    end if;
    if char_length(normalized_host) > 253
       or normalized_host = '*'
       or normalized_host like '%*%'
       or normalized_host !~ '^[a-z0-9._:-]+$'
       or normalized_host in ('localhost', 'localhost.localdomain', 'metadata.google.internal')
       or normalized_host like '%.localhost'
       or normalized_host like '%.local' then
      raise exception 'invalid_security_scope_host:%', raw_host;
    end if;
    if not normalized_host = any(normalized_hosts) then
      normalized_hosts := array_append(normalized_hosts, normalized_host);
    end if;
  end loop;

  foreach raw_cidr in array coalesce(target_allow_ipv4_cidrs, '{}'::text[]) loop
    raw_cidr := trim(raw_cidr);
    if raw_cidr = '' then
      continue;
    end if;
    begin
      if family(raw_cidr::cidr) <> 4 then
        raise exception 'invalid_security_scope_cidr:%', raw_cidr;
      end if;
      raw_cidr := raw_cidr::cidr::text;
    exception when invalid_text_representation then
      raise exception 'invalid_security_scope_cidr:%', raw_cidr;
    end;
    if raw_cidr in ('0.0.0.0/0', '127.0.0.0/8', '169.254.0.0/16') then
      raise exception 'forbidden_security_scope_cidr:%', raw_cidr;
    end if;
    if not raw_cidr = any(normalized_cidrs) then
      normalized_cidrs := array_append(normalized_cidrs, raw_cidr);
    end if;
  end loop;

  if cardinality(normalized_hosts) = 0 and cardinality(normalized_cidrs) = 0 then
    raise exception 'security_scope_target_required';
  end if;

  if target_active then
    capabilities := array_append(capabilities, 'security.active');
  end if;

  insert into internal.integration_connections(
    organization_id, provider, external_account_id, status, created_by
  ) values (
    org_id, 'security', 'project:' || target_project_id::text, 'ready', actor_id
  )
  on conflict (organization_id, provider, external_account_id) do update
    set status = 'ready'
  returning id into security_connection_id;

  insert into internal.integration_capabilities(connection_id, capability, granted)
  values
    (security_connection_id, 'security.passive', true),
    (security_connection_id, 'security.active', true)
  on conflict (connection_id, capability) do update set granted = true;

  insert into internal.integration_resources(
    connection_id, resource_type, external_id, display_name, metadata, resource_status, updated_at
  ) values (
    security_connection_id,
    'security_scope',
    'project:' || target_project_id::text,
    'Authorized Lab targets',
    jsonb_build_object(
      'allowHosts', to_jsonb(normalized_hosts),
      'allowIpv4Cidrs', to_jsonb(normalized_cidrs),
      'authorizedBy', actor_id,
      'authorizationNote', nullif(trim(coalesce(target_authorization_note, '')), ''),
      'configuredAt', now()
    ),
    'available',
    now()
  )
  on conflict (connection_id, resource_type, external_id) do update
    set display_name = excluded.display_name,
        metadata = excluded.metadata,
        resource_status = 'available',
        updated_at = now()
  returning id into security_resource_id;

  insert into public.project_integration_resources(project_id, resource_id, enabled, created_by, updated_at)
  values(target_project_id, security_resource_id, true, actor_id, now())
  on conflict (project_id, resource_id) do update
    set enabled = true,
        updated_at = now();

  delete from public.integration_resource_grants
  where project_id = target_project_id
    and resource_id = security_resource_id;

  insert into public.integration_resource_grants(project_id, resource_id, capability, granted, granted_by)
  select target_project_id, security_resource_id, capability, true, actor_id
  from unnest(capabilities) as capability;

  -- Existing Lab conversations in the project immediately inherit the configured
  -- scope. New runs also auto-attach it in the API, so first and later turns share
  -- the same explicit authority boundary.
  insert into public.conversation_resource_selections(conversation_id, resource_id, selected_by)
  select c.id, security_resource_id, actor_id
  from public.conversations c
  where c.project_id = target_project_id
    and c.mode = 'lab'
  on conflict (conversation_id, resource_id) do nothing;

  select coalesce(jsonb_agg(g.capability order by g.capability), '[]'::jsonb)
  into result_capabilities
  from public.integration_resource_grants g
  where g.project_id = target_project_id
    and g.resource_id = security_resource_id
    and g.granted;

  insert into audit.audit_events(
    organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    org_id,
    actor_id,
    'security.scope.configured',
    'integration_resource',
    security_resource_id::text,
    'success',
    jsonb_build_object(
      'project_id', target_project_id,
      'host_count', cardinality(normalized_hosts),
      'cidr_count', cardinality(normalized_cidrs),
      'active', target_active,
      'capabilities', result_capabilities
    )
  );

  return jsonb_build_object(
    'projectId', target_project_id,
    'resourceId', security_resource_id,
    'allowHosts', to_jsonb(normalized_hosts),
    'allowIpv4Cidrs', to_jsonb(normalized_cidrs),
    'active', target_active,
    'capabilities', result_capabilities
  );
end;
$$;

revoke all on function public.configure_project_security_scope(uuid,text[],text[],boolean,boolean,text) from public, anon;
grant execute on function public.configure_project_security_scope(uuid,text[],text[],boolean,boolean,text) to authenticated;

create or replace function public.get_project_security_scope(target_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  result jsonb;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if not exists(
    select 1 from public.projects p
    where p.id = target_project_id
      and internal.is_workspace_member(p.workspace_id)
  ) then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'projectId', target_project_id,
    'resourceId', ir.id,
    'allowHosts', coalesce(ir.metadata->'allowHosts', '[]'::jsonb),
    'allowIpv4Cidrs', coalesce(ir.metadata->'allowIpv4Cidrs', '[]'::jsonb),
    'active', exists(
      select 1 from public.integration_resource_grants g
      where g.project_id = target_project_id
        and g.resource_id = ir.id
        and g.capability = 'security.active'
        and g.granted
    ),
    'capabilities', coalesce((
      select jsonb_agg(g.capability order by g.capability)
      from public.integration_resource_grants g
      where g.project_id = target_project_id
        and g.resource_id = ir.id
        and g.granted
    ), '[]'::jsonb)
  )
  into result
  from public.project_integration_resources pir
  join internal.integration_resources ir on ir.id = pir.resource_id
  join internal.integration_connections ic on ic.id = ir.connection_id
  where pir.project_id = target_project_id
    and pir.enabled
    and ir.resource_type = 'security_scope'
    and ir.resource_status = 'available'
    and ic.provider = 'security'
    and ic.status in ('connected','active','ready')
  order by ir.updated_at desc
  limit 1;

  return result;
end;
$$;

revoke all on function public.get_project_security_scope(uuid) from public, anon;
grant execute on function public.get_project_security_scope(uuid) to authenticated;

create or replace function public.project_security_scope_for_conversation(target_conversation_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  result uuid;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if not exists(
    select 1
    from public.conversations c
    where c.id = target_conversation_id
      and c.mode = 'lab'
      and c.project_id is not null
      and internal.is_workspace_member(c.workspace_id)
  ) then
    return null;
  end if;

  select ir.id
  into result
  from public.conversations c
  join public.project_integration_resources pir on pir.project_id = c.project_id and pir.enabled
  join internal.integration_resources ir on ir.id = pir.resource_id and ir.resource_type = 'security_scope' and ir.resource_status = 'available'
  join internal.integration_connections ic on ic.id = ir.connection_id and ic.provider = 'security' and ic.status in ('connected','active','ready')
  where c.id = target_conversation_id
    and exists(
      select 1
      from public.integration_resource_grants g
      where g.project_id = c.project_id
        and g.resource_id = ir.id
        and g.capability = 'security.passive'
        and g.granted
    )
  order by ir.updated_at desc
  limit 1;

  return result;
end;
$$;

revoke all on function public.project_security_scope_for_conversation(uuid) from public, anon;
grant execute on function public.project_security_scope_for_conversation(uuid) to authenticated;

commit;
