create or replace function public.workspace_dashboard_snapshot(target_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare actor_id uuid:=auth.uid(); org_id uuid;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id=target_workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode='42501'; end if;
  return jsonb_build_object(
    'projects',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select p.id,p.name,p.description,p.created_at,p.updated_at,(select count(*) from public.conversations c where c.project_id=p.id) as conversation_count,coalesce(nullif((select count(*) from public.project_integration_resources pir join internal.integration_resources ir on ir.id=pir.resource_id where pir.project_id=p.id and pir.enabled and ir.resource_type='repository'),0),(select count(*) from public.project_repositories pr where pr.project_id=p.id)) as repository_count from public.projects p where p.workspace_id=target_workspace_id)x),
    'conversations',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select c.id,c.project_id,c.mode,c.title,c.created_at,c.updated_at,(select max(m.created_at) from public.messages m where m.conversation_id=c.id) as last_message_at,coalesce((select jsonb_agg(s.resource_id order by s.selected_at) from public.conversation_resource_selections s where s.conversation_id=c.id),'[]'::jsonb) as selected_resource_ids from public.conversations c where c.workspace_id=target_workspace_id order by c.updated_at desc limit 250)x),
    'integrations',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.created_at desc),'[]'::jsonb) from (select ic.id,ic.provider,ic.external_account_id,ic.status,ic.created_at,coalesce((select jsonb_object_agg(cap.capability,cap.granted) from internal.integration_capabilities cap where cap.connection_id=ic.id),'{}'::jsonb) as capabilities from internal.integration_connections ic where ic.organization_id=org_id)x),
    'available_resources',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.display_name),'[]'::jsonb) from (select ir.id,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,ir.resource_status as status,ic.status as connection_status,coalesce((select jsonb_agg(cap.capability order by cap.capability) from internal.integration_capabilities cap where cap.connection_id=ir.connection_id and cap.granted),'[]'::jsonb) as provider_capabilities from internal.integration_resources ir join internal.integration_connections ic on ic.id=ir.connection_id where ic.organization_id=org_id and ir.resource_status='available')x),
    'project_resources',(select coalesce(jsonb_agg(row_to_json(x) order by x.project_id,x.provider,x.display_name),'[]'::jsonb) from (select pir.project_id,pir.resource_id,pir.enabled,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,coalesce((select jsonb_agg(g.capability order by g.capability) from public.integration_resource_grants g where g.project_id=pir.project_id and g.resource_id=pir.resource_id and g.granted),'[]'::jsonb) as capabilities from public.project_integration_resources pir join public.projects p on p.id=pir.project_id join internal.integration_resources ir on ir.id=pir.resource_id join internal.integration_connections ic on ic.id=ir.connection_id where p.workspace_id=target_workspace_id)x),
    'capability_catalog',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.capability),'[]'::jsonb) from (select provider,capability,label,risk,resource_type,description from internal.integration_capability_catalog)x)
  );
end $$;
revoke all on function public.workspace_dashboard_snapshot(uuid) from public,anon;
grant execute on function public.workspace_dashboard_snapshot(uuid) to authenticated;

-- Replace the old Lab-authorization parameter with generic selected resources. The final parameter remains optional for six-argument callers.
drop function if exists public.start_agent_run(uuid,uuid,text,text,text,text,uuid);
create function public.start_agent_run(workspace_id uuid,conversation_id uuid,mode text,prompt text,request_id text,trace_id text,resource_ids uuid[] default null)
returns table(run_id uuid,resolved_conversation_id uuid)
language plpgsql security definer set search_path=''
as $$
declare actor_id uuid:=auth.uid(); org_id uuid; target_conversation_id uuid:=conversation_id; target_project_id uuid; conversation_mode text; selected_alias text; new_run_id uuid; resources jsonb;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if mode not in ('chat','code','lab','research') then raise exception 'invalid_mode'; end if;
  if char_length(trim(prompt))<1 or char_length(prompt)>100000 then raise exception 'invalid_prompt'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id=workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied'; end if;
  if not internal.has_permission(org_id,case when mode='lab' then 'lab.run' else 'agent.run' end) then raise exception 'permission_denied'; end if;
  if target_conversation_id is null then
    insert into public.conversations(workspace_id,created_by,mode,title) values(workspace_id,actor_id,mode,left(trim(prompt),100)) returning id,project_id,public.conversations.mode into target_conversation_id,target_project_id,conversation_mode;
  else
    select c.project_id,c.mode into target_project_id,conversation_mode from public.conversations c where c.id=target_conversation_id and c.workspace_id=start_agent_run.workspace_id;
    if not found then raise exception 'conversation_access_denied'; end if;
    if conversation_mode<>mode then raise exception 'conversation_mode_mismatch'; end if;
    update public.conversations c set title=case when c.title is null or c.title='Ny chatt' then left(trim(prompt),100) else c.title end,updated_at=now() where c.id=target_conversation_id;
  end if;
  if resource_ids is not null then perform public.set_conversation_resources(target_conversation_id,resource_ids); end if;
  insert into public.messages(conversation_id,actor_user_id,role,content) values(target_conversation_id,actor_id,'user',jsonb_build_object('text',prompt));
  resources:=internal.resource_context_for_conversation(target_conversation_id);
  selected_alias:=case mode when 'code' then 'code-prod' when 'lab' then 'lab-prod' when 'research' then 'research-prod' else 'general-prod' end;
  insert into internal.agent_runs(conversation_id,organization_id,requested_by,status,request_id,trace_id,model_alias,mode,resource_context) values(target_conversation_id,org_id,actor_id,'queued',request_id,trace_id,selected_alias,mode,resources) returning id into new_run_id;
  insert into audit.audit_events(organization_id,actor_user_id,request_id,trace_id,event_type,target_type,target_id,outcome,metadata_redacted) values(org_id,actor_id,request_id,trace_id,'agent.run.requested','agent_run',new_run_id::text,'accepted',jsonb_build_object('mode',mode,'project_id',target_project_id,'resource_count',jsonb_array_length(resources)));
  return query select new_run_id,target_conversation_id;
end $$;
revoke all on function public.start_agent_run(uuid,uuid,text,text,text,text,uuid[]) from public,anon;
grant execute on function public.start_agent_run(uuid,uuid,text,text,text,text,uuid[]) to authenticated;
