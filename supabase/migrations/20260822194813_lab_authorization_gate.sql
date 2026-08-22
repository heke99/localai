begin;

drop function if exists public.start_agent_run(uuid, uuid, text, text, text, text);
create function public.start_agent_run(workspace_id uuid, conversation_id uuid, mode text, prompt text, request_id text, trace_id text, lab_authorization_id uuid default null)
returns table (run_id uuid, resolved_conversation_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare actor_id uuid := auth.uid(); org_id uuid; target_conversation_id uuid := conversation_id; selected_alias text; new_run_id uuid;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if mode not in ('chat','code','lab','research') then raise exception 'invalid_mode'; end if;
  if char_length(trim(prompt)) < 1 or char_length(prompt) > 100000 then raise exception 'invalid_prompt'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id = workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied'; end if;
  if not internal.has_permission(org_id, case when mode = 'lab' then 'lab.run' else 'agent.run' end) then raise exception 'permission_denied'; end if;
  if mode = 'lab' and not exists (select 1 from internal.lab_authorizations la where la.id = lab_authorization_id and la.organization_id = org_id and la.revoked_at is null and now() between la.valid_from and la.valid_to) then raise exception 'lab_authorization_required'; end if;
  if target_conversation_id is null then
    insert into public.conversations(workspace_id, created_by, mode, title) values (workspace_id, actor_id, mode, left(trim(prompt), 100)) returning id into target_conversation_id;
  elsif not exists (select 1 from public.conversations c where c.id = target_conversation_id and c.workspace_id = start_agent_run.workspace_id) then raise exception 'conversation_access_denied';
  end if;
  insert into public.messages(conversation_id, actor_user_id, role, content) values (target_conversation_id, actor_id, 'user', jsonb_build_object('text', prompt));
  selected_alias := case mode when 'code' then 'code-prod' when 'lab' then 'lab-prod' when 'research' then 'research-prod' else 'general-prod' end;
  insert into internal.agent_runs(conversation_id, organization_id, requested_by, status, request_id, trace_id, model_alias, mode) values (target_conversation_id, org_id, actor_id, 'queued', request_id, trace_id, selected_alias, mode) returning id into new_run_id;
  insert into audit.audit_events(organization_id, actor_user_id, request_id, trace_id, event_type, target_type, target_id, outcome, metadata_redacted) values (org_id, actor_id, request_id, trace_id, 'agent.run.requested', 'agent_run', new_run_id::text, 'accepted', jsonb_build_object('mode',mode,'lab_authorization_id',lab_authorization_id));
  return query select new_run_id, target_conversation_id;
end $$;
revoke all on function public.start_agent_run(uuid, uuid, text, text, text, text, uuid) from public;
grant execute on function public.start_agent_run(uuid, uuid, text, text, text, text, uuid) to authenticated;

commit;
