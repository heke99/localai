begin;

create or replace function public.delete_conversation(target_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  target_workspace_id uuid;
  target_organization_id uuid;
  target_created_by uuid;
  target_mode text;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select c.workspace_id, w.organization_id, c.created_by, c.mode
    into target_workspace_id, target_organization_id, target_created_by, target_mode
  from public.conversations c
  join public.workspaces w on w.id = c.workspace_id
  where c.id = target_conversation_id;

  if target_workspace_id is null then
    raise exception 'conversation_not_found';
  end if;

  if not internal.is_workspace_member(target_workspace_id) then
    raise exception 'conversation_access_denied' using errcode = '42501';
  end if;

  if target_created_by <> actor_id and not internal.has_permission(target_organization_id, 'project.write') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  if exists (
    select 1
    from internal.agent_runs r
    where r.conversation_id = target_conversation_id
      and r.status::text not in ('completed', 'failed', 'cancelled', 'timed_out')
  ) then
    raise exception 'conversation_has_active_run';
  end if;

  delete from public.conversation_resource_selections
  where conversation_id = target_conversation_id;

  delete from public.conversations
  where id = target_conversation_id;

  insert into audit.audit_events(
    organization_id,
    actor_user_id,
    event_type,
    target_type,
    target_id,
    outcome,
    metadata_redacted
  ) values (
    target_organization_id,
    actor_id,
    'conversation.deleted',
    'conversation',
    target_conversation_id::text,
    'success',
    jsonb_build_object('mode', target_mode)
  );

  return jsonb_build_object('id', target_conversation_id);
end;
$$;

revoke all on function public.delete_conversation(uuid) from public, anon, authenticated;
grant execute on function public.delete_conversation(uuid) to authenticated;

create or replace function public.delete_project(target_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  target_workspace_id uuid;
  target_organization_id uuid;
  target_system_kind text;
  deleted_conversation_count integer := 0;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select p.workspace_id, w.organization_id, p.system_kind
    into target_workspace_id, target_organization_id, target_system_kind
  from public.projects p
  join public.workspaces w on w.id = p.workspace_id
  where p.id = target_project_id;

  if target_workspace_id is null then
    raise exception 'project_not_found';
  end if;

  if target_system_kind is not null then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;

  if not internal.is_workspace_member(target_workspace_id) then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;

  if not internal.has_permission(target_organization_id, 'project.write') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  if exists (
    select 1
    from internal.agent_runs r
    join public.conversations c on c.id = r.conversation_id
    where c.project_id = target_project_id
      and r.status::text not in ('completed', 'failed', 'cancelled', 'timed_out')
  ) then
    raise exception 'project_has_active_run';
  end if;

  select count(*)::integer into deleted_conversation_count
  from public.conversations
  where project_id = target_project_id;

  delete from public.conversations
  where project_id = target_project_id;

  delete from public.projects
  where id = target_project_id
    and system_kind is null;

  if not found then
    raise exception 'project_not_found';
  end if;

  insert into audit.audit_events(
    organization_id,
    actor_user_id,
    event_type,
    target_type,
    target_id,
    outcome,
    metadata_redacted
  ) values (
    target_organization_id,
    actor_id,
    'project.deleted',
    'project',
    target_project_id::text,
    'success',
    jsonb_build_object('deleted_conversations', deleted_conversation_count)
  );

  return jsonb_build_object(
    'id', target_project_id,
    'deletedConversations', deleted_conversation_count
  );
end;
$$;

revoke all on function public.delete_project(uuid) from public, anon, authenticated;
grant execute on function public.delete_project(uuid) to authenticated;

commit;
