begin;

create table if not exists internal.direct_model_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'running' check (status in ('running','completed','failed','cancelled')),
  request_id text not null unique,
  trace_id text not null,
  model_alias text not null,
  mode text not null check (mode in ('chat','code','lab','research')),
  input_message_id uuid references public.messages(id) on delete set null,
  output_message_id uuid references public.messages(id) on delete set null,
  failure_code text,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists direct_model_runs_conversation_time_idx
  on internal.direct_model_runs(conversation_id, created_at desc);
create index if not exists direct_model_runs_actor_time_idx
  on internal.direct_model_runs(requested_by, created_at desc);
create unique index if not exists direct_model_runs_one_active_per_conversation_idx
  on internal.direct_model_runs(conversation_id)
  where status = 'running';

alter table internal.direct_model_runs enable row level security;
grant all on table internal.direct_model_runs to service_role;

create or replace function public.get_conversation_selected_resource_ids(target_conversation_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(s.resource_id order by s.selected_at), '{}'::uuid[])
  from public.conversation_resource_selections s
  join public.conversations c on c.id = s.conversation_id
  where c.id = target_conversation_id
    and internal.is_workspace_member(c.workspace_id)
$$;

revoke all on function public.get_conversation_selected_resource_ids(uuid) from public, anon;
grant execute on function public.get_conversation_selected_resource_ids(uuid) to authenticated;

create or replace function public.prepare_direct_model_run(
  target_workspace_id uuid,
  target_conversation_id uuid,
  target_mode text,
  target_prompt text,
  target_request_id text,
  target_trace_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  resolved_conversation_id uuid := target_conversation_id;
  resolved_project_id uuid;
  conversation_mode text;
  selected_alias text;
  created_input_message_id uuid;
  created_direct_run_id uuid;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if target_mode not in ('chat','code','lab','research') then
    raise exception 'invalid_mode';
  end if;
  if char_length(trim(coalesce(target_prompt,''))) < 1 or char_length(target_prompt) > 100000 then
    raise exception 'invalid_prompt';
  end if;
  if nullif(trim(coalesce(target_request_id,'')), '') is null or nullif(trim(coalesce(target_trace_id,'')), '') is null then
    raise exception 'request_identity_required';
  end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id = target_workspace_id
    and internal.is_workspace_member(w.id);

  if org_id is null then
    raise exception 'workspace_access_denied' using errcode = '42501';
  end if;
  if not internal.has_permission(org_id, case when target_mode = 'lab' then 'lab.run' else 'agent.run' end) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if not internal.current_actor_has_agent_access(org_id) then
    raise exception 'subscription_access_required' using errcode = '42501';
  end if;

  if resolved_conversation_id is null then
    resolved_project_id := internal.ensure_standalone_project(target_workspace_id, actor_id);
    insert into public.conversations(workspace_id, project_id, created_by, mode, title)
    values(target_workspace_id, resolved_project_id, actor_id, target_mode, left(trim(target_prompt), 100))
    returning id, mode into resolved_conversation_id, conversation_mode;
  else
    select c.project_id, c.mode into resolved_project_id, conversation_mode
    from public.conversations c
    where c.id = resolved_conversation_id
      and c.workspace_id = target_workspace_id
      and internal.is_workspace_member(c.workspace_id)
    for update;

    if not found then
      raise exception 'conversation_access_denied' using errcode = '42501';
    end if;
    if conversation_mode <> target_mode then
      raise exception 'conversation_mode_mismatch';
    end if;
    if resolved_project_id is null then
      resolved_project_id := internal.ensure_standalone_project(target_workspace_id, actor_id);
      update public.conversations set project_id = resolved_project_id where id = resolved_conversation_id;
    end if;
    update public.conversations c
    set title = case when c.title is null or c.title = 'Ny chatt' then left(trim(target_prompt), 100) else c.title end,
        updated_at = now()
    where c.id = resolved_conversation_id;
  end if;

  -- A direct inference turn and an agent turn must never intentionally share a
  -- conversation at the same time. The unique direct index closes same-path races;
  -- this check blocks normal cross-path overlap before we persist the user turn.
  if exists (
    select 1 from internal.agent_runs r
    where r.conversation_id = resolved_conversation_id
      and r.status::text not in ('completed','failed','cancelled','timed_out')
  ) then
    raise exception 'conversation_has_active_run';
  end if;

  -- Recover an abandoned direct request after the HTTP execution window. Normal
  -- requests finish or fail through the service-only completion functions below.
  update internal.direct_model_runs r
  set status = 'failed', failure_code = 'stale_direct_model_run', updated_at = now(), finished_at = now()
  where r.conversation_id = resolved_conversation_id
    and r.status = 'running'
    and r.created_at < now() - interval '10 minutes';

  if exists (
    select 1 from internal.direct_model_runs r
    where r.conversation_id = resolved_conversation_id and r.status = 'running'
  ) then
    raise exception 'conversation_has_active_run';
  end if;

  insert into public.messages(conversation_id, actor_user_id, role, content)
  values(resolved_conversation_id, actor_id, 'user', jsonb_build_object('text', target_prompt, 'execution', 'direct'))
  returning id into created_input_message_id;

  selected_alias := case target_mode
    when 'code' then 'code-prod'
    when 'lab' then 'lab-prod'
    when 'research' then 'research-prod'
    else 'general-prod'
  end;

  insert into internal.direct_model_runs(
    conversation_id, organization_id, requested_by, status, request_id, trace_id,
    model_alias, mode, input_message_id
  ) values (
    resolved_conversation_id, org_id, actor_id, 'running', trim(target_request_id), trim(target_trace_id),
    selected_alias, target_mode, created_input_message_id
  ) returning id into created_direct_run_id;

  insert into audit.audit_events(
    organization_id, actor_user_id, request_id, trace_id, event_type,
    target_type, target_id, outcome, metadata_redacted
  ) values (
    org_id, actor_id, trim(target_request_id), trim(target_trace_id),
    'model.direct.requested', 'direct_model_run', created_direct_run_id::text, 'accepted',
    jsonb_build_object('mode', target_mode, 'model_alias', selected_alias, 'conversation_id', resolved_conversation_id)
  );

  return jsonb_build_object(
    'directRunId', created_direct_run_id,
    'conversationId', resolved_conversation_id,
    'modelAlias', selected_alias,
    'mode', target_mode
  );
end;
$$;

revoke all on function public.prepare_direct_model_run(uuid,uuid,text,text,text,text) from public, anon;
grant execute on function public.prepare_direct_model_run(uuid,uuid,text,text,text,text) to authenticated;

create or replace function public.complete_direct_model_run(
  target_direct_run_id uuid,
  target_output_text text,
  target_input_tokens bigint,
  target_output_tokens bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  direct_run internal.direct_model_runs%rowtype;
  model_version_id uuid;
  created_output_message_id uuid;
begin
  select * into direct_run
  from internal.direct_model_runs r
  where r.id = target_direct_run_id
  for update;

  if direct_run.id is null then raise exception 'direct_model_run_not_found'; end if;
  if direct_run.status <> 'running' then raise exception 'direct_model_run_not_active'; end if;
  if nullif(trim(coalesce(target_output_text,'')), '') is null then raise exception 'direct_model_output_empty'; end if;
  if coalesce(target_input_tokens,0) < 0 or coalesce(target_output_tokens,0) < 0 then raise exception 'invalid_usage'; end if;

  select ma.model_version_id into model_version_id
  from internal.model_aliases ma
  where ma.alias = direct_run.model_alias
  limit 1;

  insert into public.messages(conversation_id, actor_user_id, role, content, model_version_id)
  values(
    direct_run.conversation_id,
    null,
    'assistant',
    jsonb_build_object('text', target_output_text, 'execution', 'direct', 'direct_run_id', direct_run.id),
    model_version_id
  ) returning id into created_output_message_id;

  update internal.direct_model_runs
  set status = 'completed',
      output_message_id = created_output_message_id,
      input_tokens = coalesce(target_input_tokens,0),
      output_tokens = coalesce(target_output_tokens,0),
      updated_at = now(),
      finished_at = now()
  where id = direct_run.id;

  update public.conversations set updated_at = now() where id = direct_run.conversation_id;

  insert into internal.usage_events(
    organization_id, user_id, run_id, model_version_id,
    input_tokens, output_tokens, occurred_at
  ) values (
    direct_run.organization_id, direct_run.requested_by, null, model_version_id,
    coalesce(target_input_tokens,0), coalesce(target_output_tokens,0), now()
  );

  insert into audit.audit_events(
    organization_id, actor_user_id, request_id, trace_id, event_type,
    target_type, target_id, outcome, metadata_redacted
  ) values (
    direct_run.organization_id, direct_run.requested_by, direct_run.request_id, direct_run.trace_id,
    'model.direct.completed', 'direct_model_run', direct_run.id::text, 'completed',
    jsonb_build_object(
      'mode', direct_run.mode,
      'model_alias', direct_run.model_alias,
      'input_tokens', coalesce(target_input_tokens,0),
      'output_tokens', coalesce(target_output_tokens,0)
    )
  );

  return jsonb_build_object(
    'directRunId', direct_run.id,
    'conversationId', direct_run.conversation_id,
    'messageId', created_output_message_id
  );
end;
$$;

revoke all on function public.complete_direct_model_run(uuid,text,bigint,bigint) from public, anon, authenticated;
grant execute on function public.complete_direct_model_run(uuid,text,bigint,bigint) to service_role;

create or replace function public.fail_direct_model_run(
  target_direct_run_id uuid,
  target_failure_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  direct_run internal.direct_model_runs%rowtype;
begin
  select * into direct_run
  from internal.direct_model_runs r
  where r.id = target_direct_run_id
  for update;

  if direct_run.id is null then return false; end if;
  if direct_run.status <> 'running' then return false; end if;

  update internal.direct_model_runs
  set status = 'failed',
      failure_code = left(coalesce(nullif(trim(target_failure_code),''),'direct_model_failed'), 160),
      updated_at = now(),
      finished_at = now()
  where id = direct_run.id;

  insert into audit.audit_events(
    organization_id, actor_user_id, request_id, trace_id, event_type,
    target_type, target_id, outcome, metadata_redacted
  ) values (
    direct_run.organization_id, direct_run.requested_by, direct_run.request_id, direct_run.trace_id,
    'model.direct.failed', 'direct_model_run', direct_run.id::text, 'failed',
    jsonb_build_object('failure_code', left(coalesce(nullif(trim(target_failure_code),''),'direct_model_failed'),160))
  );

  return true;
end;
$$;

revoke all on function public.fail_direct_model_run(uuid,text) from public, anon, authenticated;
grant execute on function public.fail_direct_model_run(uuid,text) to service_role;

commit;
