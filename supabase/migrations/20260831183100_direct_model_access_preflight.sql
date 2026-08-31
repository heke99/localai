begin;

create or replace function public.direct_model_access_preflight(
  target_workspace_id uuid,
  target_conversation_id uuid,
  target_mode text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  conversation_mode text;
  selected_alias text;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if target_mode not in ('chat','code','lab','research') then raise exception 'invalid_mode'; end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id = target_workspace_id
    and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode = '42501'; end if;
  if not internal.has_permission(org_id, case when target_mode = 'lab' then 'lab.run' else 'agent.run' end) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not internal.current_actor_has_agent_access(org_id) then
    raise exception 'subscription_access_required' using errcode = '42501';
  end if;

  if target_conversation_id is not null then
    select c.mode into conversation_mode
    from public.conversations c
    where c.id = target_conversation_id
      and c.workspace_id = target_workspace_id
      and internal.is_workspace_member(c.workspace_id);
    if not found then raise exception 'conversation_access_denied' using errcode = '42501'; end if;
    if conversation_mode <> target_mode then raise exception 'conversation_mode_mismatch'; end if;
    if exists (
      select 1 from internal.agent_runs r
      where r.conversation_id = target_conversation_id
        and r.status::text not in ('completed','failed','cancelled','timed_out')
    ) then raise exception 'conversation_has_active_run'; end if;
    if exists (
      select 1 from internal.direct_model_runs r
      where r.conversation_id = target_conversation_id
        and r.status = 'running'
        and r.created_at >= now() - interval '10 minutes'
    ) then raise exception 'conversation_has_active_run'; end if;
  end if;

  selected_alias := case target_mode
    when 'code' then 'code-prod'
    when 'lab' then 'lab-prod'
    when 'research' then 'research-prod'
    else 'general-prod'
  end;

  return jsonb_build_object('allowed', true, 'modelAlias', selected_alias, 'mode', target_mode);
end;
$$;

revoke all on function public.direct_model_access_preflight(uuid,uuid,text) from public, anon;
grant execute on function public.direct_model_access_preflight(uuid,uuid,text) to authenticated;

commit;
