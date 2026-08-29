create or replace function public.worker_reap_stale_agent_runs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stale record;
  reaped integer := 0;
begin
  for stale in
    select q.id as job_id, q.run_id
    from internal.job_queue q
    join internal.agent_runs r on r.id = q.run_id
    where q.queue = 'agent-runs'
      and q.status = 'running'
      and q.leased_until is not null
      and q.leased_until < now()
      and r.status in ('planning','running','waiting_for_tool','verifying')
      and r.updated_at < now() - case when r.mode in ('chat','research') then interval '3 minutes' else interval '20 minutes' end
    order by q.leased_until asc
    for update of q, r skip locked
  loop
    update internal.agent_runs
       set status = 'failed'::internal.run_status,
           failure_code = 'stale_worker_lease_expired',
           finished_at = now(),
           updated_at = now(),
           active_skill = null
     where id = stale.run_id
       and status in ('planning','running','waiting_for_tool','verifying');

    if found then
      update internal.job_queue
         set status = 'failed'::internal.run_status,
             leased_by = null,
             leased_until = null,
             last_error_code = 'stale_worker_lease_expired',
             updated_at = now()
       where id = stale.job_id and run_id = stale.run_id;
      reaped := reaped + 1;
    end if;
  end loop;
  return reaped;
end;
$$;

revoke all on function public.worker_reap_stale_agent_runs() from public, anon, authenticated;
grant execute on function public.worker_reap_stale_agent_runs() to service_role;

create or replace function public.worker_record_agent_step(target_run_id uuid, step_kind text, step_status text, summary text, state jsonb default '{}'::jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  sequence_number integer;
  current_status internal.run_status;
  current_cancel_requested_at timestamptz;
begin
  select r.status, r.cancel_requested_at into current_status, current_cancel_requested_at
  from internal.agent_runs r where r.id = target_run_id for update;

  if not found or current_cancel_requested_at is not null or current_status in ('completed','failed','cancelled','timed_out') then
    return 0;
  end if;

  select coalesce(max(s.sequence_no), 0) + 1 into sequence_number
  from internal.agent_steps s where s.run_id = target_run_id;

  insert into internal.agent_steps(run_id, sequence_no, kind, status, input)
  values(target_run_id, sequence_number, step_kind, step_status::internal.run_status, jsonb_build_object('summary', summary));

  insert into internal.agent_checkpoints(run_id, step_sequence, state)
  values(target_run_id, sequence_number, state || jsonb_build_object('status', step_status));

  update internal.agent_runs
     set status = step_status::internal.run_status,
         active_skill = case when step_kind = 'skill' then summary else active_skill end,
         updated_at = now()
   where id = target_run_id;

  update internal.job_queue
     set leased_until = greatest(coalesce(leased_until, now()), now() + interval '2 minutes'),
         updated_at = now()
   where run_id = target_run_id and queue = 'agent-runs' and status = 'running';

  return sequence_number;
end;
$$;

create or replace function public.worker_append_agent_run_stream(target_run_id uuid, delta text, reset_stream boolean default false)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_revision bigint;
begin
  if length(coalesce(delta, '')) > 20000 then raise exception 'stream_delta_too_large'; end if;

  update internal.agent_runs r
     set stream_content = case when reset_stream then coalesce(delta, '') else left(r.stream_content || coalesce(delta, ''), 2000000) end,
         stream_revision = r.stream_revision + 1,
         updated_at = now()
   where r.id = target_run_id and r.status not in ('completed','failed','cancelled','timed_out')
   returning stream_revision into next_revision;
  if next_revision is null then raise exception 'stream_run_not_writable'; end if;

  update internal.job_queue
     set leased_until = greatest(coalesce(leased_until, now()), now() + interval '2 minutes'),
         updated_at = now()
   where run_id = target_run_id and queue = 'agent-runs' and status = 'running';

  return next_revision;
end;
$$;

create or replace function public.worker_claim_agent_run(worker_id text)
returns table(job_id uuid, run_id uuid, conversation_id uuid, organization_id uuid, requested_by uuid, mode text, model_alias text, prompt text, request_id text, trace_id text, resource_context jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  claimed_job internal.job_queue%rowtype;
begin
  perform public.worker_reap_stale_agent_runs();

  for candidate in
    select q.id as job_id, r.requested_by
    from internal.job_queue q
    join internal.agent_runs r on r.id = q.run_id
    join public.messages input_message on input_message.id = r.input_message_id and input_message.conversation_id = r.conversation_id and input_message.role = 'user'
    where q.queue = 'agent-runs'
      and q.status in ('queued','retrying')
      and q.available_at <= now()
      and (q.leased_until is null or q.leased_until < now())
      and r.status in ('queued','retrying')
      and not exists (
        select 1 from internal.agent_runs active
        where active.requested_by = r.requested_by
          and active.status in ('planning','running','waiting_for_tool','verifying')
      )
    order by q.priority asc, q.created_at asc
    for update of q skip locked
  loop
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.requested_by::text, 0)) then continue; end if;
    if exists (
      select 1 from internal.agent_runs active
      where active.requested_by = candidate.requested_by
        and active.status in ('planning','running','waiting_for_tool','verifying')
    ) then continue; end if;

    select * into claimed_job from internal.job_queue q where q.id = candidate.job_id;
    perform 1 from internal.agent_runs r where r.id = claimed_job.run_id and r.status in ('queued','retrying') for update;
    if not found then continue; end if;

    update internal.job_queue q
       set status='running', leased_by=worker_id, leased_until=now()+interval '2 minutes', attempts=attempts+1, updated_at=now()
     where q.id=claimed_job.id;
    update internal.agent_runs r
       set status='planning', started_at=coalesce(started_at,now()), updated_at=now()
     where r.id=claimed_job.run_id and r.status in ('queued','retrying');

    return query
    select claimed_job.id, r.id, r.conversation_id, r.organization_id, r.requested_by, r.mode, r.model_alias,
           coalesce(input_message.content->>'text',''), r.request_id, r.trace_id, r.resource_context
    from internal.agent_runs r
    join public.messages input_message on input_message.id = r.input_message_id and input_message.conversation_id = r.conversation_id and input_message.role = 'user'
    where r.id = claimed_job.run_id;
    return;
  end loop;
  return;
end;
$$;
