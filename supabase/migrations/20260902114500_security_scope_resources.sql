begin;

insert into internal.integration_capability_catalog(provider,capability,label,risk,resource_type,description) values
  ('security','security.passive','Passive security checks','read','security_scope','HTTP, TLS and DNS inspection inside the explicitly selected Lab target scope'),
  ('security','security.active','Active security checks','sensitive','security_scope','Bounded port, template and content-discovery checks inside the explicitly selected Lab target scope')
on conflict (provider,capability) do update
set label=excluded.label,risk=excluded.risk,resource_type=excluded.resource_type,description=excluded.description;

create or replace function public.upsert_project_security_scope(
  target_project_id uuid,
  target_display_name text,
  target_allow_hosts text[],
  target_allow_ipv4_cidrs text[] default '{}'::text[],
  target_allow_active boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  workspace_id uuid;
  org_id uuid;
  project_mode text;
  connection_id uuid;
  resource_id uuid;
  scope_key text;
  normalized_hosts text[] := '{}'::text[];
  normalized_cidrs text[] := '{}'::text[];
  item text;
  capabilities text[];
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;

  select p.workspace_id,w.organization_id,p.mode
    into workspace_id,org_id,project_mode
  from public.projects p
  join public.workspaces w on w.id=p.workspace_id
  where p.id=target_project_id
    and p.system_kind is null
    and internal.is_workspace_member(p.workspace_id);

  if org_id is null then
    raise exception 'project_access_denied' using errcode='42501';
  end if;
  if project_mode <> 'lab' then
    raise exception 'lab_project_required' using errcode='42501';
  end if;
  if not internal.has_permission(org_id,'lab.run') or not internal.has_permission(org_id,'project.write') then
    raise exception 'permission_denied' using errcode='42501';
  end if;
  if length(trim(coalesce(target_display_name,''))) < 1 or length(trim(target_display_name)) > 160 then
    raise exception 'invalid_security_scope_name';
  end if;

  foreach item in array coalesce(target_allow_hosts,'{}'::text[]) loop
    item := lower(trim(trailing '.' from trim(item)));
    if item = '' or length(item) > 253 or item !~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' then
      raise exception 'invalid_security_scope_host';
    end if;
    if item in ('localhost','metadata.google.internal') or item like '%.localhost' or item like '%.local' then
      raise exception 'blocked_security_scope_host';
    end if;
    normalized_hosts := array_append(normalized_hosts,item);
  end loop;

  foreach item in array coalesce(target_allow_ipv4_cidrs,'{}'::text[]) loop
    item := trim(item);
    if item !~ '^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$' then
      raise exception 'invalid_security_scope_cidr';
    end if;
    if split_part(item,'.',1)::integer > 255
       or split_part(item,'.',2)::integer > 255
       or split_part(item,'.',3)::integer > 255
       or split_part(split_part(item,'.',4),'/',1)::integer > 255 then
      raise exception 'invalid_security_scope_cidr';
    end if;
    if item ~ '^127\.' or item ~ '^169\.254\.' or item ~ '^0\.' then
      raise exception 'blocked_security_scope_cidr';
    end if;
    normalized_cidrs := array_append(normalized_cidrs,item);
  end loop;

  select coalesce(array_agg(distinct h order by h),'{}'::text[]) into normalized_hosts from unnest(normalized_hosts) h;
  select coalesce(array_agg(distinct c order by c),'{}'::text[]) into normalized_cidrs from unnest(normalized_cidrs) c;

  if cardinality(normalized_hosts)=0 and cardinality(normalized_cidrs)=0 then
    raise exception 'security_scope_target_required';
  end if;
  if cardinality(normalized_hosts) > 32 or cardinality(normalized_cidrs) > 32 then
    raise exception 'security_scope_too_large';
  end if;

  insert into internal.integration_connections(organization_id,provider,external_account_id,status,created_by)
  values(org_id,'security','lab-security-executor','ready',actor_id)
  on conflict(organization_id,provider,external_account_id) do update
    set status='ready'
  returning id into connection_id;

  insert into internal.integration_capabilities(connection_id,capability,granted) values
    (connection_id,'security.passive',true),
    (connection_id,'security.active',true)
  on conflict(connection_id,capability) do update set granted=true;

  scope_key := encode(extensions.digest(
    convert_to(array_to_string(normalized_hosts,',') || '|' || array_to_string(normalized_cidrs,','),'UTF8'),
    'sha256'
  ),'hex');

  insert into internal.integration_resources(connection_id,resource_type,external_id,display_name,metadata,resource_status,updated_at)
  values(
    connection_id,
    'security_scope',
    'scope:' || scope_key,
    trim(target_display_name),
    jsonb_build_object('allowHosts',to_jsonb(normalized_hosts),'allowIpv4Cidrs',to_jsonb(normalized_cidrs)),
    'available',
    now()
  )
  on conflict(connection_id,resource_type,external_id) do update
    set display_name=excluded.display_name,
        metadata=excluded.metadata,
        resource_status='available',
        updated_at=now()
  returning id into resource_id;

  insert into public.project_integration_resources(project_id,resource_id,enabled,created_by,updated_at)
  values(target_project_id,resource_id,true,actor_id,now())
  on conflict(project_id,resource_id) do update set enabled=true,updated_at=now();

  delete from public.integration_resource_grants
  where project_id=target_project_id and resource_id=resource_id;

  capabilities := case when target_allow_active
    then array['security.passive','security.active']::text[]
    else array['security.passive']::text[]
  end;

  insert into public.integration_resource_grants(project_id,resource_id,capability,granted,granted_by)
  select target_project_id,resource_id,cap,true,actor_id from unnest(capabilities) cap
  on conflict(project_id,resource_id,capability) do update set granted=true,granted_by=actor_id,updated_at=now();

  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values(
    org_id,actor_id,'lab.security_scope.configured','integration_resource',resource_id::text,'success',
    jsonb_build_object(
      'project_id',target_project_id,
      'host_count',cardinality(normalized_hosts),
      'cidr_count',cardinality(normalized_cidrs),
      'active',target_allow_active
    )
  );

  return jsonb_build_object(
    'projectId',target_project_id,
    'resourceId',resource_id,
    'displayName',trim(target_display_name),
    'allowHosts',to_jsonb(normalized_hosts),
    'allowIpv4Cidrs',to_jsonb(normalized_cidrs),
    'capabilities',to_jsonb(capabilities)
  );
end;
$$;

revoke all on function public.upsert_project_security_scope(uuid,text,text[],text[],boolean) from public,anon;
grant execute on function public.upsert_project_security_scope(uuid,text,text[],text[],boolean) to authenticated;

commit;
