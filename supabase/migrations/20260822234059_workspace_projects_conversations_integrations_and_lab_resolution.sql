create or replace function public.create_project(
  target_workspace_id uuid,
  target_name text,
  target_description text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
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
  if length(trim(coalesce(target_name, ''))) < 1 or length(trim(target_name)) > 120 then
    raise exception 'invalid_project_name';
  end if;
  if target_description is not null and length(target_description) > 2000 then
    raise exception 'invalid_project_description';
  end if;

  insert into public.projects(workspace_id, name, description, created_by)
  values (target_workspace_id, trim(target_name), nullif(trim(coalesce(target_description, '')), ''), actor_id)
  returning * into created_project;

  insert into audit.audit_events(organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted)
  values (org_id, actor_id, 'project.created', 'project', created_project.id::text, 'completed', jsonb_build_object('name', created_project.name));

  return jsonb_build_object(
    'id', created_project.id,
    'workspace_id', created_project.workspace_id,
    'name', created_project.name,
    'description', created_project.description,
    'created_at', created_project.created_at,
    'updated_at', created_project.updated_at
  );
end;
$$;

revoke all on function public.create_project(uuid,text,text) from public, anon;
grant execute on function public.create_project(uuid,text,text) to authenticated;

create or replace function public.create_conversation(
  target_workspace_id uuid,
  target_project_id uuid,
  target_mode text,
  target_title text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
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
    select 1 from public.projects p where p.id=target_project_id and p.workspace_id=target_workspace_id
  ) then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;
  if normalized_title is not null and length(normalized_title) > 160 then
    raise exception 'invalid_conversation_title';
  end if;

  insert into public.conversations(workspace_id, project_id, created_by, mode, title)
  values (target_workspace_id, target_project_id, actor_id, target_mode, coalesce(normalized_title, 'Ny chatt'))
  returning * into created_conversation;

  return jsonb_build_object(
    'id', created_conversation.id,
    'workspace_id', created_conversation.workspace_id,
    'project_id', created_conversation.project_id,
    'mode', created_conversation.mode,
    'title', created_conversation.title,
    'created_at', created_conversation.created_at,
    'updated_at', created_conversation.updated_at
  );
end;
$$;

revoke all on function public.create_conversation(uuid,uuid,text,text) from public, anon;
grant execute on function public.create_conversation(uuid,uuid,text,text) to authenticated;

create or replace function public.workspace_dashboard_snapshot(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id=target_workspace_id and internal.is_workspace_member(w.id);

  if org_id is null then
    raise exception 'workspace_access_denied' using errcode='42501';
  end if;

  return jsonb_build_object(
    'projects', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc), '[]'::jsonb)
      from (
        select p.id,p.name,p.description,p.created_at,p.updated_at,
               (select count(*) from public.conversations c where c.project_id=p.id) as conversation_count,
               (select count(*) from public.project_repositories pr where pr.project_id=p.id) as repository_count
        from public.projects p
        where p.workspace_id=target_workspace_id
      ) x
    ),
    'conversations', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc), '[]'::jsonb)
      from (
        select c.id,c.project_id,c.mode,c.title,c.created_at,c.updated_at,
               (select max(m.created_at) from public.messages m where m.conversation_id=c.id) as last_message_at
        from public.conversations c
        where c.workspace_id=target_workspace_id
        order by c.updated_at desc
        limit 250
      ) x
    ),
    'integrations', (
      select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.created_at desc), '[]'::jsonb)
      from (
        select ic.id,ic.provider,ic.external_account_id,ic.status,ic.created_at,
               coalesce((select jsonb_object_agg(cap.capability,cap.granted) from internal.integration_capabilities cap where cap.connection_id=ic.id), '{}'::jsonb) as capabilities
        from internal.integration_connections ic
        where ic.organization_id=org_id
      ) x
    )
  );
end;
$$;

revoke all on function public.workspace_dashboard_snapshot(uuid) from public, anon;
grant execute on function public.workspace_dashboard_snapshot(uuid) to authenticated;

create or replace function public.request_integration_connection(
  target_workspace_id uuid,
  target_provider text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  normalized_provider text := lower(trim(coalesce(target_provider,'')));
  existing internal.integration_connections%rowtype;
  created internal.integration_connections%rowtype;
  pending_reference text;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id=target_workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode='42501'; end if;
  if not internal.has_permission(org_id,'integration.manage') then raise exception 'permission_denied' using errcode='42501'; end if;
  if normalized_provider not in ('github','supabase','vercel') then raise exception 'provider_not_supported'; end if;

  select * into existing
  from internal.integration_connections ic
  where ic.organization_id=org_id and ic.provider=normalized_provider and ic.status in ('connected','active','ready')
  order by ic.created_at desc
  limit 1;

  if found then
    return jsonb_build_object('id',existing.id,'provider',existing.provider,'status',existing.status,'external_account_id',existing.external_account_id);
  end if;

  pending_reference := 'pending:' || actor_id::text;
  insert into internal.integration_connections(organization_id,provider,external_account_id,status,created_by)
  values (org_id,normalized_provider,pending_reference,'pending',actor_id)
  on conflict (organization_id,provider,external_account_id) do update set status='pending'
  returning * into created;

  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (org_id,actor_id,'integration.connection.requested','integration_connection',created.id::text,'accepted',jsonb_build_object('provider',normalized_provider));

  return jsonb_build_object('id',created.id,'provider',created.provider,'status',created.status,'external_account_id',created.external_account_id);
end;
$$;

revoke all on function public.request_integration_connection(uuid,text) from public, anon;
grant execute on function public.request_integration_connection(uuid,text) to authenticated;

create or replace function public.start_agent_run(workspace_id uuid, conversation_id uuid, mode text, prompt text, request_id text, trace_id text, lab_authorization_id uuid default null)
returns table(run_id uuid, resolved_conversation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  target_conversation_id uuid := conversation_id;
  target_project_id uuid;
  conversation_mode text;
  selected_alias text;
  new_run_id uuid;
  resolved_lab_authorization_id uuid;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if mode not in ('chat','code','lab','research') then raise exception 'invalid_mode'; end if;
  if char_length(trim(prompt)) < 1 or char_length(prompt) > 100000 then raise exception 'invalid_prompt'; end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id=workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied'; end if;
  if not internal.has_permission(org_id, case when mode='lab' then 'lab.run' else 'agent.run' end) then raise exception 'permission_denied'; end if;

  if target_conversation_id is null then
    insert into public.conversations(workspace_id,created_by,mode,title)
    values (workspace_id,actor_id,mode,left(trim(prompt),100))
    returning id,project_id,public.conversations.mode into target_conversation_id,target_project_id,conversation_mode;
  else
    select c.project_id,c.mode into target_project_id,conversation_mode
    from public.conversations c
    where c.id=target_conversation_id and c.workspace_id=start_agent_run.workspace_id;
    if not found then raise exception 'conversation_access_denied'; end if;
    if conversation_mode <> mode then raise exception 'conversation_mode_mismatch'; end if;
    update public.conversations c
    set title=case when c.title is null or c.title='Ny chatt' then left(trim(prompt),100) else c.title end,
        updated_at=now()
    where c.id=target_conversation_id;
  end if;

  if mode='lab' then
    select la.id into resolved_lab_authorization_id
    from internal.lab_authorizations la
    where la.organization_id=org_id
      and la.revoked_at is null
      and now() between la.valid_from and la.valid_to
      and (la.project_id is null or la.project_id=target_project_id)
    order by case when la.project_id is not null and la.project_id=target_project_id then 0 else 1 end,
             la.valid_to desc
    limit 1;
    if resolved_lab_authorization_id is null then raise exception 'lab_authorization_required'; end if;
  end if;

  insert into public.messages(conversation_id,actor_user_id,role,content)
  values (target_conversation_id,actor_id,'user',jsonb_build_object('text',prompt));

  selected_alias := case mode when 'code' then 'code-prod' when 'lab' then 'lab-prod' when 'research' then 'research-prod' else 'general-prod' end;
  insert into internal.agent_runs(conversation_id,organization_id,requested_by,status,request_id,trace_id,model_alias,mode)
  values (target_conversation_id,org_id,actor_id,'queued',request_id,trace_id,selected_alias,mode)
  returning id into new_run_id;

  insert into audit.audit_events(organization_id,actor_user_id,request_id,trace_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (org_id,actor_id,request_id,trace_id,'agent.run.requested','agent_run',new_run_id::text,'accepted',
          jsonb_build_object('mode',mode,'project_id',target_project_id,'resolved_lab_authorization_id',resolved_lab_authorization_id));

  return query select new_run_id,target_conversation_id;
end;
$$;

revoke all on function public.start_agent_run(uuid,uuid,text,text,text,text,uuid) from public, anon;
grant execute on function public.start_agent_run(uuid,uuid,text,text,text,text,uuid) to authenticated;
