begin;

create or replace function internal.enqueue_agent_run() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into internal.job_queue(queue, run_id, payload, dedupe_key)
  values ('agent-runs', new.id, jsonb_build_object('run_id', new.id), new.request_id)
  on conflict (queue, dedupe_key) do nothing;
  return new;
end $$;
revoke all on function internal.enqueue_agent_run() from public, anon, authenticated;

drop trigger if exists enqueue_agent_run_trigger on internal.agent_runs;
create trigger enqueue_agent_run_trigger after insert on internal.agent_runs for each row execute function internal.enqueue_agent_run();

create or replace function public.worker_claim_agent_run(worker_id text)
returns table (job_id uuid, run_id uuid, conversation_id uuid, organization_id uuid, requested_by uuid, mode text, model_alias text, prompt text, request_id text, trace_id text)
language plpgsql security definer set search_path = ''
as $$
declare claimed_job internal.job_queue%rowtype;
begin
  select * into claimed_job from internal.job_queue q
  where q.queue = 'agent-runs' and q.status in ('queued','retrying') and q.available_at <= now()
    and (q.leased_until is null or q.leased_until < now())
  order by q.priority asc, q.created_at asc for update skip locked limit 1;
  if claimed_job.id is null then return; end if;
  update internal.job_queue q set status = 'running', leased_by = worker_id, leased_until = now() + interval '2 minutes', attempts = attempts + 1, updated_at = now() where q.id = claimed_job.id;
  update internal.agent_runs r set status = 'planning', started_at = coalesce(started_at, now()), updated_at = now() where r.id = claimed_job.run_id and r.status in ('queued','retrying');
  return query
  select claimed_job.id, r.id, r.conversation_id, r.organization_id, r.requested_by, r.mode, r.model_alias,
    coalesce(m.content->>'text',''), r.request_id, r.trace_id
  from internal.agent_runs r
  left join lateral (select msg.content from public.messages msg where msg.conversation_id = r.conversation_id and msg.role = 'user' order by msg.created_at desc limit 1) m on true
  where r.id = claimed_job.run_id;
end $$;
revoke all on function public.worker_claim_agent_run(text) from public, anon, authenticated;
grant execute on function public.worker_claim_agent_run(text) to service_role;

create or replace function public.worker_record_agent_step(target_run_id uuid, step_kind text, step_status text, summary text, state jsonb default '{}')
returns integer language plpgsql security definer set search_path = ''
as $$
declare sequence_number integer;
begin
  select coalesce(max(s.sequence_no), 0) + 1 into sequence_number from internal.agent_steps s where s.run_id = target_run_id;
  insert into internal.agent_steps(run_id, sequence_no, kind, status, input) values (target_run_id, sequence_number, step_kind, step_status::internal.run_status, jsonb_build_object('summary', summary));
  insert into internal.agent_checkpoints(run_id, step_sequence, state) values (target_run_id, sequence_number, state || jsonb_build_object('status', step_status));
  update internal.agent_runs set status = step_status::internal.run_status, active_skill = case when step_kind = 'skill' then summary else active_skill end, updated_at = now() where id = target_run_id;
  return sequence_number;
end $$;
revoke all on function public.worker_record_agent_step(uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.worker_record_agent_step(uuid,text,text,text,jsonb) to service_role;

create or replace function public.worker_complete_agent_run(target_run_id uuid, target_job_id uuid, output_content text, model_version uuid default null, usage jsonb default '{}')
returns void language plpgsql security definer set search_path = ''
as $$
declare conv_id uuid; org_id uuid; actor_id uuid; req_id text; tr_id text;
begin
  select conversation_id, organization_id, requested_by, request_id, trace_id into conv_id, org_id, actor_id, req_id, tr_id from internal.agent_runs where id = target_run_id for update;
  insert into public.messages(conversation_id, role, content, model_version_id) values (conv_id, 'assistant', jsonb_build_object('text', output_content), model_version);
  update internal.agent_runs set status = 'completed', finished_at = now(), updated_at = now(), active_skill = null where id = target_run_id;
  update internal.job_queue set status = 'completed', leased_until = null, updated_at = now() where id = target_job_id and run_id = target_run_id;
  insert into internal.usage_events(organization_id,user_id,run_id,model_version_id,input_tokens,output_tokens,cached_tokens,gpu_seconds,queue_ms)
  values (org_id,actor_id,target_run_id,model_version,coalesce((usage->>'inputTokens')::bigint,0),coalesce((usage->>'outputTokens')::bigint,0),coalesce((usage->>'cachedTokens')::bigint,0),coalesce((usage->>'gpuSeconds')::numeric,0),coalesce((usage->>'queueMs')::integer,0));
  insert into audit.audit_events(organization_id,actor_user_id,request_id,trace_id,event_type,target_type,target_id,outcome) values (org_id,actor_id,req_id,tr_id,'agent.run.completed','agent_run',target_run_id::text,'success');
end $$;
revoke all on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) to service_role;

create or replace function public.worker_fail_agent_run(target_run_id uuid, target_job_id uuid, error_code text, retryable boolean default false)
returns void language plpgsql security definer set search_path = ''
as $$
declare next_status internal.run_status; job_attempts integer; max_attempts integer;
begin
  select attempts, maximum_attempts into job_attempts, max_attempts from internal.job_queue where id = target_job_id for update;
  next_status := case when retryable and job_attempts < max_attempts then 'retrying'::internal.run_status else 'failed'::internal.run_status end;
  update internal.agent_runs set status = next_status, failure_code = error_code, finished_at = case when next_status = 'failed' then now() else null end, updated_at = now() where id = target_run_id;
  update internal.job_queue set status = next_status, last_error_code = error_code, available_at = case when next_status = 'retrying' then now() + make_interval(secs => least(60, power(2, job_attempts)::integer)) else available_at end, leased_until = null, updated_at = now() where id = target_job_id;
end $$;
revoke all on function public.worker_fail_agent_run(uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.worker_fail_agent_run(uuid,uuid,text,boolean) to service_role;

commit;
