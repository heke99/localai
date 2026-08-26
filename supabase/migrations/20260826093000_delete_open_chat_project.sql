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
  cancelled_run_count integer := 0;
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

  with cancelled_runs as (
    update internal.agent_runs r
       set cancel_requested_at = coalesce(r.cancel_requested_at, now()),
           status = 'cancelled'::internal.run_status,
           finished_at = coalesce(r.finished_at, now()),
           updated_at = now(),
           active_skill = null
     where r.conversation_id = target_conversation_id
       and r.status::text not in ('completed', 'failed', 'cancelled', 'timed_out')
    returning r.id
  )
  select count(*)::integer into cancelled_run_count from cancelled_runs;

  update internal.job_queue q
     set status = 'cancelled'::internal.run_status,
         leased_until = null,
         updated_at = now(),
         last_error_code = coalesce(q.last_error_code, 'conversation_deleted')
   where q.run_id in (
     select r.id
     from internal.agent_runs r
     where r.conversation_id = target_conversation_id
   )
     and q.status::text not in ('completed', 'failed', 'cancelled', 'timed_out');

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
    jsonb_build_object('mode', target_mode, 'cancelled_runs', cancelled_run_count)
  );

  return jsonb_build_object(
    'id', target_conversation_id,
    'cancelledRuns', cancelled_run_count
  );
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
  target_created_by uuid;
  target_system_kind text;
  deleted_conversation_count integer := 0;
  cancelled_run_count integer := 0;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select p.workspace_id, w.organization_id, p.created_by, p.system_kind
    into target_workspace_id, target_organization_id, target_created_by, target_system_kind
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

  if target_created_by <> actor_id and not internal.has_permission(target_organization_id, 'project.write') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  with cancelled_runs as (
    update internal.agent_runs r
       set cancel_requested_at = coalesce(r.cancel_requested_at, now()),
           status = 'cancelled'::internal.run_status,
           finished_at = coalesce(r.finished_at, now()),
           updated_at = now(),
           active_skill = null
     where r.conversation_id in (
       select c.id
       from public.conversations c
       where c.project_id = target_project_id
     )
       and r.status::text not in ('completed', 'failed', 'cancelled', 'timed_out')
    returning r.id
  )
  select count(*)::integer into cancelled_run_count from cancelled_runs;

  update internal.job_queue q
     set status = 'cancelled'::internal.run_status,
         leased_until = null,
         updated_at = now(),
         last_error_code = coalesce(q.last_error_code, 'project_deleted')
   where q.run_id in (
     select r.id
     from internal.agent_runs r
     join public.conversations c on c.id = r.conversation_id
     where c.project_id = target_project_id
   )
     and q.status::text not in ('completed', 'failed', 'cancelled', 'timed_out');

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
    jsonb_build_object(
      'deleted_conversations', deleted_conversation_count,
      'cancelled_runs', cancelled_run_count
    )
  );

  return jsonb_build_object(
    'id', target_project_id,
    'deletedConversations', deleted_conversation_count,
    'cancelledRuns', cancelled_run_count
  );
end;
$$;

revoke all on function public.delete_project(uuid) from public, anon, authenticated;
grant execute on function public.delete_project(uuid) to authenticated;

create or replace function public.worker_record_agent_step(
  target_run_id uuid,
  step_kind text,
  step_status text,
  summary text,
  state jsonb default '{}'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  sequence_number integer;
  run_status text;
  run_cancel_requested_at timestamptz;
begin
  select r.status::text, r.cancel_requested_at
    into run_status, run_cancel_requested_at
  from internal.agent_runs r
  where r.id = target_run_id
  for update;

  if run_status is null then
    return 0;
  end if;

  if run_cancel_requested_at is not null
     or run_status in ('completed', 'failed', 'cancelled', 'timed_out') then
    return 0;
  end if;

  select coalesce(max(s.sequence_no), 0) + 1
    into sequence_number
  from internal.agent_steps s
  where s.run_id = target_run_id;

  insert into internal.agent_steps(run_id, sequence_no, kind, status, input)
  values (
    target_run_id,
    sequence_number,
    step_kind,
    step_status::internal.run_status,
    jsonb_build_object('summary', summary)
  );

  insert into internal.agent_checkpoints(run_id, step_sequence, state)
  values (
    target_run_id,
    sequence_number,
    state || jsonb_build_object('status', step_status)
  );

  update internal.agent_runs
     set status = step_status::internal.run_status,
         active_skill = case when step_kind = 'skill' then summary else active_skill end,
         updated_at = now()
   where id = target_run_id
     and cancel_requested_at is null
     and status::text not in ('completed', 'failed', 'cancelled', 'timed_out');

  return sequence_number;
end;
$$;

revoke all on function public.worker_record_agent_step(uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.worker_record_agent_step(uuid,text,text,text,jsonb) to service_role;

create or replace function public.worker_complete_agent_run(
  target_run_id uuid,
  target_job_id uuid,
  output_content text,
  model_version uuid default null,
  usage jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  conv_id uuid;
  org_id uuid;
  actor_id uuid;
  req_id text;
  tr_id text;
  current_status text;
  current_cancel_requested_at timestamptz;
begin
  select r.conversation_id,
         r.organization_id,
         r.requested_by,
         r.request_id,
         r.trace_id,
         r.status::text,
         r.cancel_requested_at
    into conv_id,
         org_id,
         actor_id,
         req_id,
         tr_id,
         current_status,
         current_cancel_requested_at
  from internal.agent_runs r
  where r.id = target_run_id
  for update;

  if current_status is null then
    update internal.job_queue
       set status = 'cancelled'::internal.run_status,
           leased_until = null,
           updated_at = now()
     where id = target_job_id;
    return;
  end if;

  if current_cancel_requested_at is not null
     or current_status = 'cancelled'
     or conv_id is null
     or not exists (select 1 from public.conversations c where c.id = conv_id) then
    update internal.agent_runs
       set status = 'cancelled'::internal.run_status,
           finished_at = coalesce(finished_at, now()),
           updated_at = now(),
           active_skill = null
     where id = target_run_id
       and status::text not in ('completed', 'failed', 'timed_out');

    update internal.job_queue
       set status = 'cancelled'::internal.run_status,
           leased_until = null,
           updated_at = now(),
           last_error_code = coalesce(last_error_code, 'run_cancelled')
     where id = target_job_id
       and run_id = target_run_id;
    return;
  end if;

  if current_status in ('completed', 'failed', 'timed_out') then
    return;
  end if;

  insert into public.messages(conversation_id, role, content, model_version_id)
  values (conv_id, 'assistant', jsonb_build_object('text', output_content), model_version);

  update internal.agent_runs
     set status = 'completed'::internal.run_status,
         finished_at = now(),
         updated_at = now(),
         active_skill = null
   where id = target_run_id;

  update internal.job_queue
     set status = 'completed'::internal.run_status,
         leased_until = null,
         updated_at = now()
   where id = target_job_id
     and run_id = target_run_id;

  insert into internal.usage_events(
    organization_id,
    user_id,
    run_id,
    model_version_id,
    input_tokens,
    output_tokens,
    cached_tokens,
    gpu_seconds,
    queue_ms
  ) values (
    org_id,
    actor_id,
    target_run_id,
    model_version,
    coalesce((usage->>'inputTokens')::bigint, 0),
    coalesce((usage->>'outputTokens')::bigint, 0),
    coalesce((usage->>'cachedTokens')::bigint, 0),
    coalesce((usage->>'gpuSeconds')::numeric, 0),
    coalesce((usage->>'queueMs')::integer, 0)
  );

  insert into audit.audit_events(
    organization_id,
    actor_user_id,
    request_id,
    trace_id,
    event_type,
    target_type,
    target_id,
    outcome
  ) values (
    org_id,
    actor_id,
    req_id,
    tr_id,
    'agent.run.completed',
    'agent_run',
    target_run_id::text,
    'success'
  );
end;
$$;

revoke all on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) to service_role;

create or replace function public.worker_fail_agent_run(
  target_run_id uuid,
  target_job_id uuid,
  error_code text,
  retryable boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_status internal.run_status;
  job_attempts integer;
  max_attempts integer;
  current_status text;
  current_cancel_requested_at timestamptz;
begin
  select r.status::text, r.cancel_requested_at
    into current_status, current_cancel_requested_at
  from internal.agent_runs r
  where r.id = target_run_id
  for update;

  if current_status is null
     or current_cancel_requested_at is not null
     or current_status = 'cancelled' then
    update internal.job_queue
       set status = 'cancelled'::internal.run_status,
           leased_until = null,
           updated_at = now(),
           last_error_code = coalesce(last_error_code, 'run_cancelled')
     where id = target_job_id;
    return;
  end if;

  if current_status in ('completed', 'failed', 'timed_out') then
    return;
  end if;

  select attempts, maximum_attempts
    into job_attempts, max_attempts
  from internal.job_queue
  where id = target_job_id
  for update;

  next_status := case
    when retryable and job_attempts < max_attempts then 'retrying'::internal.run_status
    else 'failed'::internal.run_status
  end;

  update internal.agent_runs
     set status = next_status,
         failure_code = error_code,
         finished_at = case when next_status = 'failed'::internal.run_status then now() else null end,
         updated_at = now()
   where id = target_run_id;

  update internal.job_queue
     set status = next_status,
         last_error_code = error_code,
         available_at = case
           when next_status = 'retrying'::internal.run_status
             then now() + make_interval(secs => least(60, power(2, job_attempts)::integer))
           else available_at
         end,
         leased_until = null,
         updated_at = now()
   where id = target_job_id;
end;
$$;

revoke all on function public.worker_fail_agent_run(uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.worker_fail_agent_run(uuid,uuid,text,boolean) to service_role;

commit;
