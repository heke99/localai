begin;

create or replace function public.configure_project_integration_resource(
  target_project_id uuid,
  target_resource_id uuid,
  target_capabilities text[],
  target_enabled boolean default true
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  resolved_workspace_id uuid;
  resolved_org_id uuid;
  resolved_connection_id uuid;
  resolved_provider_name text;
  resolved_connection_status text;
  requested_capability text;
  capabilities_json jsonb;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select p.workspace_id,w.organization_id into resolved_workspace_id,resolved_org_id
  from public.projects p join public.workspaces w on w.id=p.workspace_id
  where p.id=target_project_id and internal.is_workspace_member(p.workspace_id);
  if resolved_org_id is null then raise exception 'project_access_denied' using errcode='42501'; end if;
  if not internal.has_permission(resolved_org_id,'project.write') or not internal.has_permission(resolved_org_id,'integration.manage') then
    raise exception 'permission_denied' using errcode='42501';
  end if;

  select ir.connection_id,ic.provider,ic.status
    into resolved_connection_id,resolved_provider_name,resolved_connection_status
  from internal.integration_resources ir
  join internal.integration_connections ic on ic.id=ir.connection_id
  where ir.id=target_resource_id and ir.resource_status='available' and ic.organization_id=resolved_org_id;
  if resolved_connection_id is null then raise exception 'integration_resource_not_found'; end if;
  if target_enabled and resolved_connection_status not in ('connected','active','ready') then raise exception 'integration_not_connected'; end if;

  insert into public.project_integration_resources(project_id,resource_id,enabled,created_by,updated_at)
  values(target_project_id,target_resource_id,target_enabled,actor_id,now())
  on conflict(project_id,resource_id) do update set enabled=excluded.enabled,updated_at=now();

  delete from public.integration_resource_grants g
  where g.project_id=target_project_id and g.resource_id=target_resource_id;

  if target_enabled then
    foreach requested_capability in array coalesce(target_capabilities,'{}'::text[]) loop
      if not exists(
        select 1 from internal.integration_capability_catalog cc
        where cc.provider=resolved_provider_name and cc.capability=requested_capability
      ) then raise exception 'unknown_integration_capability:%',requested_capability; end if;
      if not exists(
        select 1 from internal.integration_capabilities icap
        where icap.connection_id=resolved_connection_id
          and icap.capability=requested_capability
          and icap.granted
      ) then raise exception 'provider_capability_not_granted:%',requested_capability; end if;
      insert into public.integration_resource_grants(project_id,resource_id,capability,granted,granted_by)
      values(target_project_id,target_resource_id,requested_capability,true,actor_id);
    end loop;
  end if;

  select coalesce(jsonb_agg(g.capability order by g.capability),'[]'::jsonb)
    into capabilities_json
  from public.integration_resource_grants g
  where g.project_id=target_project_id and g.resource_id=target_resource_id and g.granted;

  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values(resolved_org_id,actor_id,'integration.resource.configured','integration_resource',target_resource_id::text,'success',
    jsonb_build_object('project_id',target_project_id,'enabled',target_enabled,'capabilities',capabilities_json));
  return jsonb_build_object('projectId',target_project_id,'resourceId',target_resource_id,'enabled',target_enabled,'capabilities',capabilities_json);
end $$;

revoke all on function public.configure_project_integration_resource(uuid,uuid,text[],boolean) from public,anon;
grant execute on function public.configure_project_integration_resource(uuid,uuid,text[],boolean) to authenticated;

create or replace function public.set_conversation_resources(target_conversation_id uuid, target_resource_ids uuid[])
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  resolved_project_id uuid;
  resolved_workspace_id uuid;
  resolved_org_id uuid;
  selected_resource_id uuid;
  resolved_connection_id uuid;
  resolved_provider text;
  resolved_resource_type text;
  binding_exists boolean;
  selected_json jsonb;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;

  select c.project_id,c.workspace_id,w.organization_id
    into resolved_project_id,resolved_workspace_id,resolved_org_id
  from public.conversations c
  join public.workspaces w on w.id=c.workspace_id
  where c.id=target_conversation_id and internal.is_workspace_member(c.workspace_id);
  if resolved_workspace_id is null then raise exception 'conversation_access_denied' using errcode='42501'; end if;

  if resolved_project_id is null then
    resolved_project_id := internal.ensure_standalone_project(resolved_workspace_id,actor_id);
    update public.conversations c set project_id=resolved_project_id,updated_at=now() where c.id=target_conversation_id;
  end if;

  foreach selected_resource_id in array coalesce(target_resource_ids,'{}'::uuid[]) loop
    resolved_connection_id := null;
    resolved_provider := null;
    resolved_resource_type := null;
    select ir.connection_id,ic.provider,ir.resource_type
      into resolved_connection_id,resolved_provider,resolved_resource_type
    from internal.integration_resources ir
    join internal.integration_connections ic on ic.id=ir.connection_id
    where ir.id=selected_resource_id
      and ir.resource_status='available'
      and ic.organization_id=resolved_org_id
      and ic.status in ('connected','active','ready');
    if resolved_connection_id is null then raise exception 'resource_not_available:%',selected_resource_id; end if;

    select exists(
      select 1 from public.project_integration_resources pir
      where pir.project_id=resolved_project_id and pir.resource_id=selected_resource_id
    ) into binding_exists;

    if not binding_exists then
      if not internal.has_permission(resolved_org_id,'project.write') then raise exception 'permission_denied' using errcode='42501'; end if;
      insert into public.project_integration_resources(project_id,resource_id,enabled,created_by)
      values(resolved_project_id,selected_resource_id,true,actor_id)
      on conflict(project_id,resource_id) do update set enabled=true,updated_at=now();

      insert into public.integration_resource_grants(project_id,resource_id,capability,granted,granted_by)
      select resolved_project_id,selected_resource_id,catalog.capability,true,actor_id
      from internal.integration_capability_catalog catalog
      join internal.integration_capabilities provider_cap
        on provider_cap.connection_id=resolved_connection_id
       and provider_cap.capability=catalog.capability
       and provider_cap.granted
      where catalog.provider=resolved_provider
        and catalog.resource_type=resolved_resource_type
        and catalog.risk in ('read','write')
      on conflict(project_id,resource_id,capability)
      do update set granted=true,granted_by=actor_id,updated_at=now();
    elsif exists(
      select 1 from public.project_integration_resources pir
      where pir.project_id=resolved_project_id and pir.resource_id=selected_resource_id and not pir.enabled
    ) then
      if not internal.has_permission(resolved_org_id,'project.write') then raise exception 'permission_denied' using errcode='42501'; end if;
      update public.project_integration_resources pir set enabled=true,updated_at=now()
      where pir.project_id=resolved_project_id and pir.resource_id=selected_resource_id;
    end if;

    if not exists(
      select 1 from public.project_integration_resources pir
      where pir.project_id=resolved_project_id and pir.resource_id=selected_resource_id and pir.enabled
    ) then raise exception 'resource_not_available:%',selected_resource_id; end if;
  end loop;

  delete from public.conversation_resource_selections s where s.conversation_id=target_conversation_id;
  foreach selected_resource_id in array coalesce(target_resource_ids,'{}'::uuid[]) loop
    insert into public.conversation_resource_selections(conversation_id,resource_id,selected_by)
    values(target_conversation_id,selected_resource_id,actor_id);
  end loop;

  selected_json := internal.resource_context_for_conversation(target_conversation_id);
  return jsonb_build_object('conversationId',target_conversation_id,'resources',selected_json);
end $$;

revoke all on function public.set_conversation_resources(uuid,uuid[]) from public,anon;
grant execute on function public.set_conversation_resources(uuid,uuid[]) to authenticated;

create or replace function public.worker_authorize_tool_call(target_run_id uuid,target_resource_id uuid,target_capability text)
returns jsonb
language plpgsql stable security definer set search_path=''
as $$
declare
  resolved_run_org uuid;
  resolved_conversation_id uuid;
  resolved_project_id uuid;
  resolved_actor_id uuid;
  result jsonb;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select r.organization_id,r.conversation_id,r.requested_by,c.project_id
    into resolved_run_org,resolved_conversation_id,resolved_actor_id,resolved_project_id
  from internal.agent_runs r
  join public.conversations c on c.id=r.conversation_id
  where r.id=target_run_id;
  if resolved_run_org is null then raise exception 'run_not_found'; end if;

  select jsonb_build_object(
    'runId',target_run_id,'actorId',resolved_actor_id,'resourceId',ir.id,
    'connectionId',ir.connection_id,'provider',ic.provider,'resourceType',ir.resource_type,
    'externalResourceId',ir.external_id,'displayName',coalesce(ir.display_name,ir.external_id),
    'metadata',ir.metadata,'capability',target_capability
  ) into result
  from public.conversation_resource_selections s
  join public.project_integration_resources pir
    on pir.project_id=resolved_project_id and pir.resource_id=s.resource_id and pir.enabled
  join public.integration_resource_grants g
    on g.project_id=resolved_project_id and g.resource_id=s.resource_id
   and g.capability=target_capability and g.granted
  join internal.integration_resources ir on ir.id=s.resource_id and ir.resource_status='available'
  join internal.integration_connections ic
    on ic.id=ir.connection_id and ic.organization_id=resolved_run_org
   and ic.status in ('connected','active','ready')
  join internal.integration_capabilities cap
    on cap.connection_id=ic.id and cap.capability=target_capability and cap.granted
  where s.conversation_id=resolved_conversation_id and s.resource_id=target_resource_id;
  if result is null then raise exception 'tool_resource_capability_denied' using errcode='42501'; end if;
  return result;
end $$;

revoke all on function public.worker_authorize_tool_call(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.worker_authorize_tool_call(uuid,uuid,text) to service_role;

commit;
