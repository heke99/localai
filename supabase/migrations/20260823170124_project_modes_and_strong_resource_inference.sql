-- Scope visible projects to a single product mode and let strong provider evidence
-- auto-link related resources without expanding write/destructive permissions.

alter table public.projects add column if not exists mode text;

with single_modes as (
  select c.project_id, min(c.mode) as mode
  from public.conversations c
  join public.projects p on p.id = c.project_id
  where p.system_kind is null
  group by c.project_id
  having count(distinct c.mode) = 1
)
update public.projects p
set mode = sm.mode
from single_modes sm
where p.id = sm.project_id and p.mode is null;

update public.projects set mode = 'chat' where mode is null;
alter table public.projects alter column mode set default 'chat';
alter table public.projects alter column mode set not null;
alter table public.projects drop constraint if exists projects_mode_check;
alter table public.projects add constraint projects_mode_check check (mode in ('chat','code','lab','research'));

create index if not exists projects_workspace_mode_updated_idx
  on public.projects(workspace_id, mode, updated_at desc)
  where system_kind is null;

create or replace function public.create_project(
  target_workspace_id uuid,
  target_name text,
  target_description text,
  target_mode text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  normalized_mode text := lower(trim(coalesce(target_mode,'')));
  created_project public.projects%rowtype;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id = target_workspace_id
    and internal.is_workspace_member(w.id);

  if org_id is null then
    raise exception 'workspace_access_denied' using errcode = '42501';
  end if;
  if not internal.has_permission(org_id, 'project.write') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if normalized_mode not in ('chat','code','lab','research') then
    raise exception 'invalid_project_mode';
  end if;
  if length(trim(coalesce(target_name, ''))) < 1 or length(trim(target_name)) > 120 then
    raise exception 'invalid_project_name';
  end if;
  if target_description is not null and length(target_description) > 2000 then
    raise exception 'invalid_project_description';
  end if;

  insert into public.projects(workspace_id, name, description, created_by, mode)
  values (
    target_workspace_id,
    trim(target_name),
    nullif(trim(coalesce(target_description, '')), ''),
    actor_id,
    normalized_mode
  )
  returning * into created_project;

  insert into audit.audit_events(
    organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    org_id, actor_id, 'project.created', 'project', created_project.id::text, 'completed',
    jsonb_build_object('name', created_project.name, 'mode', created_project.mode)
  );

  return jsonb_build_object(
    'id', created_project.id,
    'workspace_id', created_project.workspace_id,
    'name', created_project.name,
    'description', created_project.description,
    'mode', created_project.mode,
    'created_at', created_project.created_at,
    'updated_at', created_project.updated_at
  );
end;
$$;

-- Keep the legacy 3-argument RPC working during rolling deploys.
create or replace function public.create_project(
  target_workspace_id uuid,
  target_name text,
  target_description text default null
)
returns jsonb
language sql
security definer
set search_path=''
as $$
  select public.create_project(target_workspace_id, target_name, target_description, 'chat');
$$;

grant execute on function public.create_project(uuid,text,text,text) to authenticated;
revoke execute on function public.create_project(uuid,text,text,text) from anon;

create or replace function public.create_conversation(
  target_workspace_id uuid,
  target_project_id uuid,
  target_mode text,
  target_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  actual_project_id uuid := target_project_id;
  created_conversation public.conversations%rowtype;
  normalized_title text := nullif(trim(coalesce(target_title, '')), '');
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if target_mode not in ('chat','code','lab','research') then
    raise exception 'invalid_mode';
  end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id = target_workspace_id
    and internal.is_workspace_member(w.id);

  if org_id is null then
    raise exception 'workspace_access_denied' using errcode = '42501';
  end if;
  if not internal.has_permission(org_id, case when target_mode='lab' then 'lab.run' else 'agent.run' end) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if target_project_id is not null and not exists (
    select 1
    from public.projects p
    where p.id = target_project_id
      and p.workspace_id = target_workspace_id
      and p.system_kind is null
      and p.mode = target_mode
  ) then
    raise exception 'project_mode_or_access_denied' using errcode = '42501';
  end if;
  if normalized_title is not null and length(normalized_title) > 160 then
    raise exception 'invalid_conversation_title';
  end if;

  if actual_project_id is null then
    actual_project_id := internal.ensure_standalone_project(target_workspace_id, actor_id);
  end if;

  insert into public.conversations(workspace_id, project_id, created_by, mode, title)
  values (target_workspace_id, actual_project_id, actor_id, target_mode, coalesce(normalized_title, 'Ny chatt'))
  returning * into created_conversation;

  return jsonb_build_object(
    'id', created_conversation.id,
    'workspace_id', created_conversation.workspace_id,
    'project_id', target_project_id,
    'mode', created_conversation.mode,
    'title', created_conversation.title,
    'created_at', created_conversation.created_at,
    'updated_at', created_conversation.updated_at
  );
end;
$$;

-- Strong provider identifiers can safely establish application topology. The inferred
-- resource receives read-only grants only. Existing stronger grants are never removed.
create or replace function internal.reconcile_links_for_resource(target_resource_id uuid)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare
  binding record;
  candidate record;
  a_id uuid;
  b_id uuid;
  strong_match boolean;
  affected integer := 0;
begin
  for binding in
    select pir.project_id, pir.created_by, w.organization_id
    from public.project_integration_resources pir
    join public.projects p on p.id = pir.project_id
    join public.workspaces w on w.id = p.workspace_id
    where pir.resource_id = target_resource_id and pir.enabled
  loop
    for candidate in
      select distinct
        ir2.id as resource_id,
        ir2.connection_id,
        ir2.resource_type,
        ic2.provider,
        i1.kind,
        least(i1.confidence, i2.confidence) as confidence,
        (i1.source_kind = 'provider' and i2.source_kind = 'provider'
          and i1.confidence >= 0.99 and i2.confidence >= 0.99) as strong
      from internal.integration_resource_identifiers i1
      join internal.integration_resource_identifiers i2
        on i2.kind = i1.kind
       and i2.normalized_value = i1.normalized_value
       and i2.resource_id <> i1.resource_id
       and i1.linkable and i2.linkable
      join internal.integration_resources ir1 on ir1.id = i1.resource_id
      join internal.integration_connections ic1 on ic1.id = ir1.connection_id
      join internal.integration_resources ir2 on ir2.id = i2.resource_id and ir2.resource_status = 'available'
      join internal.integration_connections ic2 on ic2.id = ir2.connection_id
      where i1.resource_id = target_resource_id
        and ic1.provider <> ic2.provider
        and ic2.organization_id = binding.organization_id
        and ic2.status in ('connected','active','ready')
        and i1.confidence >= 0.90
        and i2.confidence >= 0.90
    loop
      strong_match := candidate.strong;

      if strong_match then
        insert into public.project_integration_resources(project_id, resource_id, enabled, created_by)
        values(binding.project_id, candidate.resource_id, true, binding.created_by)
        on conflict(project_id, resource_id) do update
          set enabled = true, updated_at = now()
          where not public.project_integration_resources.enabled;

        insert into public.integration_resource_grants(project_id, resource_id, capability, granted, granted_by)
        select binding.project_id, candidate.resource_id, catalog.capability, true, binding.created_by
        from internal.integration_capability_catalog catalog
        join internal.integration_capabilities provider_cap
          on provider_cap.connection_id = candidate.connection_id
         and provider_cap.capability = catalog.capability
         and provider_cap.granted
        where catalog.provider = candidate.provider
          and catalog.resource_type = candidate.resource_type
          and catalog.risk = 'read'
        on conflict(project_id, resource_id, capability) do update
          set granted = true, updated_at = now();
      end if;

      if exists(
        select 1 from public.project_integration_resources pir
        where pir.project_id = binding.project_id
          and pir.resource_id = candidate.resource_id
          and pir.enabled
      ) then
        if target_resource_id::text < candidate.resource_id::text then
          a_id := target_resource_id; b_id := candidate.resource_id;
        else
          a_id := candidate.resource_id; b_id := target_resource_id;
        end if;

        insert into public.project_resource_links(
          project_id, resource_a_id, resource_b_id, relation_key,
          status, confidence, source_kind, note
        ) values (
          binding.project_id, a_id, b_id, 'same_application',
          case when strong_match then 'confirmed' else 'suggested' end,
          candidate.confidence, 'inferred', left('Exact shared identifier: ' || candidate.kind, 2000)
        )
        on conflict(project_id,resource_a_id,resource_b_id,relation_key) do update
          set confidence = greatest(public.project_resource_links.confidence, excluded.confidence),
              status = case
                when public.project_resource_links.status = 'rejected' then 'rejected'
                when excluded.status = 'confirmed' then 'confirmed'
                else public.project_resource_links.status
              end,
              updated_at = now();
        affected := affected + 1;
      end if;
    end loop;
  end loop;

  return affected;
end;
$$;

-- Server-only directory used to enrich already-authorized resources with provider
-- evidence. It intentionally returns no credential material.
create or replace function public.service_conversation_relationship_inference_context(target_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  pid uuid;
  oid uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select c.project_id, w.organization_id into pid, oid
  from public.conversations c
  join public.workspaces w on w.id = c.workspace_id
  where c.id = target_conversation_id;

  if pid is null or oid is null then
    return jsonb_build_object('projectId', null, 'organizationId', oid, 'resources', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'projectId', pid,
    'organizationId', oid,
    'resources', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'resourceId', ir.id,
        'connectionId', ir.connection_id,
        'provider', ic.provider,
        'resourceType', ir.resource_type,
        'externalResourceId', ir.external_id,
        'displayName', coalesce(ir.display_name,ir.external_id),
        'metadata', ir.metadata,
        'selected', exists(
          select 1 from public.conversation_resource_selections s
          where s.conversation_id = target_conversation_id and s.resource_id = ir.id
        )
      ) order by ic.provider, coalesce(ir.display_name,ir.external_id)), '[]'::jsonb)
      from public.project_integration_resources pir
      join internal.integration_resources ir on ir.id = pir.resource_id and ir.resource_status = 'available'
      join internal.integration_connections ic on ic.id = ir.connection_id
        and ic.organization_id = oid and ic.status in ('connected','active','ready')
      where pir.project_id = pid and pir.enabled
    )
  );
end;
$$;

revoke all on function public.service_conversation_relationship_inference_context(uuid) from public, anon, authenticated;
grant execute on function public.service_conversation_relationship_inference_context(uuid) to service_role;

create or replace function public.workspace_dashboard_snapshot(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare actor_id uuid:=auth.uid(); org_id uuid;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id
  from public.workspaces w
  where w.id=target_workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode='42501'; end if;

  return jsonb_build_object(
    'projects',(
      select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb)
      from (
        select p.id,p.name,p.description,p.mode,p.created_at,p.updated_at,
          (select count(*) from public.conversations c where c.project_id=p.id) as conversation_count,
          coalesce(nullif((select count(*) from public.project_integration_resources pir join internal.integration_resources ir on ir.id=pir.resource_id where pir.project_id=p.id and pir.enabled and ir.resource_type='repository'),0),(select count(*) from public.project_repositories pr where pr.project_id=p.id)) as repository_count
        from public.projects p
        where p.workspace_id=target_workspace_id and p.system_kind is null
      ) x
    ),
    'conversations',(
      select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb)
      from (
        select c.id,
          case when p.system_kind is not null then null else c.project_id end as project_id,
          c.mode,c.title,c.created_at,c.updated_at,
          (select max(m.created_at) from public.messages m where m.conversation_id=c.id) as last_message_at,
          coalesce((select jsonb_agg(s.resource_id order by s.selected_at) from public.conversation_resource_selections s where s.conversation_id=c.id),'[]'::jsonb) as selected_resource_ids
        from public.conversations c
        left join public.projects p on p.id=c.project_id
        where c.workspace_id=target_workspace_id
        order by c.updated_at desc
        limit 250
      ) x
    ),
    'integrations',(
      select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.created_at desc),'[]'::jsonb)
      from (
        select ic.id,ic.provider,ic.external_account_id,ic.status,ic.created_at,
          coalesce((select jsonb_object_agg(cap.capability,cap.granted) from internal.integration_capabilities cap where cap.connection_id=ic.id),'{}'::jsonb) as capabilities
        from internal.integration_connections ic
        where ic.organization_id=org_id
      ) x
    ),
    'available_resources',(
      select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.display_name),'[]'::jsonb)
      from (
        select ir.id,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,
          coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,ir.resource_status as status,ic.status as connection_status,
          coalesce((select jsonb_agg(cap.capability order by cap.capability) from internal.integration_capabilities cap where cap.connection_id=ir.connection_id and cap.granted),'[]'::jsonb) as provider_capabilities
        from internal.integration_resources ir
        join internal.integration_connections ic on ic.id=ir.connection_id
        where ic.organization_id=org_id and ir.resource_status='available'
      ) x
    ),
    'project_resources',(
      select coalesce(jsonb_agg(row_to_json(x) order by x.project_id,x.provider,x.display_name),'[]'::jsonb)
      from (
        select pir.project_id,pir.resource_id,pir.enabled,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,
          coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,
          coalesce((select jsonb_agg(g.capability order by g.capability) from public.integration_resource_grants g where g.project_id=pir.project_id and g.resource_id=ir.id and g.granted),'[]'::jsonb) as capabilities
        from public.project_integration_resources pir
        join public.projects p on p.id=pir.project_id and p.system_kind is null
        join internal.integration_resources ir on ir.id=pir.resource_id
        join internal.integration_connections ic on ic.id=ir.connection_id
        where p.workspace_id=target_workspace_id
      ) x
    ),
    'resource_links',(
      select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb)
      from (
        select l.id,l.project_id,l.resource_a_id,l.resource_b_id,l.relation_key,l.status,l.confidence,l.source_kind,l.note,l.updated_at
        from public.project_resource_links l
        join public.projects p on p.id=l.project_id
        where p.workspace_id=target_workspace_id and p.system_kind is null
      ) x
    ),
    'capability_catalog',(
      select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.capability),'[]'::jsonb)
      from (
        select provider,capability,label,risk,resource_type,description
        from internal.integration_capability_catalog
      ) x
    )
  );
end;
$$;
