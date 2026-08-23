create or replace function internal.resource_context_for_conversation(target_conversation_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'resourceId',ir.id,'connectionId',ir.connection_id,'provider',ic.provider,'resourceType',ir.resource_type,
    'externalResourceId',ir.external_id,'displayName',coalesce(ir.display_name,ir.external_id),'metadata',ir.metadata,
    'capabilities',coalesce((select jsonb_agg(g.capability order by g.capability) from public.integration_resource_grants g where g.project_id=c.project_id and g.resource_id=ir.id and g.granted),'[]'::jsonb)
  ) order by ic.provider,coalesce(ir.display_name,ir.external_id)),'[]'::jsonb)
  from public.conversations c
  join public.conversation_resource_selections s on s.conversation_id=c.id
  join public.project_integration_resources pir on pir.project_id=c.project_id and pir.resource_id=s.resource_id and pir.enabled
  join internal.integration_resources ir on ir.id=s.resource_id and ir.resource_status='available'
  join internal.integration_connections ic on ic.id=ir.connection_id and ic.status in ('connected','active','ready')
  where c.id=target_conversation_id
$$;
revoke all on function internal.resource_context_for_conversation(uuid) from public,anon,authenticated;

create or replace function public.sync_integration_connection_capabilities(target_connection_id uuid,target_capabilities text[])
returns jsonb language plpgsql security definer set search_path=''
as $$
declare provider_name text; cap text;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select provider into provider_name from internal.integration_connections where id=target_connection_id;
  if provider_name is null then raise exception 'integration_connection_not_found'; end if;
  delete from internal.integration_capabilities where connection_id=target_connection_id;
  foreach cap in array coalesce(target_capabilities,'{}'::text[]) loop
    if not exists(select 1 from internal.integration_capability_catalog c where c.provider=provider_name and c.capability=cap) then raise exception 'unknown_integration_capability:%',cap; end if;
    insert into internal.integration_capabilities(connection_id,capability,granted) values(target_connection_id,cap,true)
    on conflict(connection_id,capability) do update set granted=true;
  end loop;
  return jsonb_build_object('connectionId',target_connection_id,'provider',provider_name,'capabilities',coalesce(to_jsonb(target_capabilities),'[]'::jsonb));
end $$;
revoke all on function public.sync_integration_connection_capabilities(uuid,text[]) from public,anon,authenticated;
grant execute on function public.sync_integration_connection_capabilities(uuid,text[]) to service_role;

create or replace function public.sync_integration_resource(target_connection_id uuid,target_resource_type text,target_external_resource_id text,target_display_name text,target_metadata jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path=''
as $$
declare provider_name text; resource_id uuid;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select provider into provider_name from internal.integration_connections where id=target_connection_id;
  if provider_name is null then raise exception 'integration_connection_not_found'; end if;
  if not exists(select 1 from internal.integration_capability_catalog c where c.provider=provider_name and c.resource_type=target_resource_type) then raise exception 'unsupported_resource_type'; end if;
  insert into internal.integration_resources(connection_id,resource_type,external_id,display_name,metadata,resource_status,updated_at)
  values(target_connection_id,target_resource_type,left(target_external_resource_id,500),left(target_display_name,240),coalesce(target_metadata,'{}'::jsonb),'available',now())
  on conflict(connection_id,resource_type,external_id) do update set display_name=excluded.display_name,metadata=excluded.metadata,resource_status='available',updated_at=now()
  returning id into resource_id;
  return resource_id;
end $$;
revoke all on function public.sync_integration_resource(uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.sync_integration_resource(uuid,text,text,text,jsonb) to service_role;

create or replace function public.configure_project_integration_resource(target_project_id uuid,target_resource_id uuid,target_capabilities text[],target_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor_id uuid:=auth.uid(); workspace_id uuid; org_id uuid; connection_id uuid; provider_name text; connection_status text; cap text; capabilities_json jsonb;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select p.workspace_id,w.organization_id into workspace_id,org_id from public.projects p join public.workspaces w on w.id=p.workspace_id where p.id=target_project_id and internal.is_workspace_member(p.workspace_id);
  if org_id is null then raise exception 'project_access_denied' using errcode='42501'; end if;
  if not internal.has_permission(org_id,'project.write') or not internal.has_permission(org_id,'integration.manage') then raise exception 'permission_denied' using errcode='42501'; end if;
  select ir.connection_id,ic.provider,ic.status into connection_id,provider_name,connection_status from internal.integration_resources ir join internal.integration_connections ic on ic.id=ir.connection_id where ir.id=target_resource_id and ir.resource_status='available' and ic.organization_id=org_id;
  if connection_id is null then raise exception 'integration_resource_not_found'; end if;
  if target_enabled and connection_status not in ('connected','active','ready') then raise exception 'integration_not_connected'; end if;
  insert into public.project_integration_resources(project_id,resource_id,enabled,created_by,updated_at) values(target_project_id,target_resource_id,target_enabled,actor_id,now())
  on conflict(project_id,resource_id) do update set enabled=excluded.enabled,updated_at=now();
  delete from public.integration_resource_grants where project_id=target_project_id and resource_id=target_resource_id;
  if target_enabled then
    foreach cap in array coalesce(target_capabilities,'{}'::text[]) loop
      if not exists(select 1 from internal.integration_capability_catalog cc where cc.provider=provider_name and cc.capability=cap) then raise exception 'unknown_integration_capability:%',cap; end if;
      if not exists(select 1 from internal.integration_capabilities icap where icap.connection_id=connection_id and icap.capability=cap and icap.granted) then raise exception 'provider_capability_not_granted:%',cap; end if;
      insert into public.integration_resource_grants(project_id,resource_id,capability,granted,granted_by) values(target_project_id,target_resource_id,cap,true,actor_id);
    end loop;
  end if;
  select coalesce(jsonb_agg(g.capability order by g.capability),'[]'::jsonb) into capabilities_json from public.integration_resource_grants g where g.project_id=target_project_id and g.resource_id=target_resource_id and g.granted;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values(org_id,actor_id,'integration.resource.configured','integration_resource',target_resource_id::text,'success',jsonb_build_object('project_id',target_project_id,'enabled',target_enabled,'capabilities',capabilities_json));
  return jsonb_build_object('projectId',target_project_id,'resourceId',target_resource_id,'enabled',target_enabled,'capabilities',capabilities_json);
end $$;
revoke all on function public.configure_project_integration_resource(uuid,uuid,text[],boolean) from public,anon;
grant execute on function public.configure_project_integration_resource(uuid,uuid,text[],boolean) to authenticated;

create or replace function public.set_conversation_resources(target_conversation_id uuid,target_resource_ids uuid[])
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor_id uuid:=auth.uid(); project_id uuid; workspace_id uuid; org_id uuid; rid uuid; selected_json jsonb;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select c.project_id,c.workspace_id,w.organization_id into project_id,workspace_id,org_id from public.conversations c join public.workspaces w on w.id=c.workspace_id where c.id=target_conversation_id and internal.is_workspace_member(c.workspace_id);
  if workspace_id is null then raise exception 'conversation_access_denied' using errcode='42501'; end if;
  if cardinality(coalesce(target_resource_ids,'{}'::uuid[]))>0 and project_id is null then raise exception 'project_required_for_integration_resources'; end if;
  foreach rid in array coalesce(target_resource_ids,'{}'::uuid[]) loop
    if not exists(select 1 from public.project_integration_resources pir join internal.integration_resources ir on ir.id=pir.resource_id and ir.resource_status='available' join internal.integration_connections ic on ic.id=ir.connection_id and ic.organization_id=org_id and ic.status in ('connected','active','ready') where pir.project_id=project_id and pir.resource_id=rid and pir.enabled) then raise exception 'resource_not_available:%',rid; end if;
  end loop;
  delete from public.conversation_resource_selections where conversation_id=target_conversation_id;
  foreach rid in array coalesce(target_resource_ids,'{}'::uuid[]) loop insert into public.conversation_resource_selections(conversation_id,resource_id,selected_by) values(target_conversation_id,rid,actor_id); end loop;
  selected_json:=internal.resource_context_for_conversation(target_conversation_id);
  return jsonb_build_object('conversationId',target_conversation_id,'resources',selected_json);
end $$;
revoke all on function public.set_conversation_resources(uuid,uuid[]) from public,anon;
grant execute on function public.set_conversation_resources(uuid,uuid[]) to authenticated;

create or replace function public.conversation_resource_context(target_conversation_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$ begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if not exists(select 1 from public.conversations c where c.id=target_conversation_id and internal.is_workspace_member(c.workspace_id)) then raise exception 'conversation_access_denied' using errcode='42501'; end if;
  return internal.resource_context_for_conversation(target_conversation_id);
end $$;
revoke all on function public.conversation_resource_context(uuid) from public,anon;
grant execute on function public.conversation_resource_context(uuid) to authenticated;

create or replace function public.worker_authorize_tool_call(target_run_id uuid,target_resource_id uuid,target_capability text)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare run_org uuid; conv_id uuid; project_id uuid; actor_id uuid; result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select r.organization_id,r.conversation_id,r.requested_by,c.project_id into run_org,conv_id,actor_id,project_id from internal.agent_runs r join public.conversations c on c.id=r.conversation_id where r.id=target_run_id;
  if run_org is null then raise exception 'run_not_found'; end if;
  select jsonb_build_object('runId',target_run_id,'actorId',actor_id,'resourceId',ir.id,'connectionId',ir.connection_id,'provider',ic.provider,'resourceType',ir.resource_type,'externalResourceId',ir.external_id,'displayName',coalesce(ir.display_name,ir.external_id),'metadata',ir.metadata,'capability',target_capability) into result
  from public.conversation_resource_selections s
  join public.project_integration_resources pir on pir.project_id=project_id and pir.resource_id=s.resource_id and pir.enabled
  join public.integration_resource_grants g on g.project_id=project_id and g.resource_id=s.resource_id and g.capability=target_capability and g.granted
  join internal.integration_resources ir on ir.id=s.resource_id and ir.resource_status='available'
  join internal.integration_connections ic on ic.id=ir.connection_id and ic.organization_id=run_org and ic.status in ('connected','active','ready')
  join internal.integration_capabilities cap on cap.connection_id=ic.id and cap.capability=target_capability and cap.granted
  where s.conversation_id=conv_id and s.resource_id=target_resource_id;
  if result is null then raise exception 'tool_resource_capability_denied' using errcode='42501'; end if;
  return result;
end $$;
revoke all on function public.worker_authorize_tool_call(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.worker_authorize_tool_call(uuid,uuid,text) to service_role;
