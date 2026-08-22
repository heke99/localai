begin;

create or replace function internal.run_transition_allowed(from_status internal.run_status, to_status internal.run_status)
returns boolean language sql immutable security invoker set search_path = ''
as $$
  select from_status = to_status or case from_status
    when 'queued' then to_status in ('planning','cancelled','failed')
    when 'planning' then to_status in ('running','waiting_for_user','cancelled','failed')
    when 'running' then to_status in ('waiting_for_tool','verifying','retrying','cancelled','failed','timed_out')
    when 'waiting' then to_status in ('running','cancelled','timed_out')
    when 'waiting_for_user' then to_status in ('running','cancelled','timed_out')
    when 'waiting_for_tool' then to_status in ('running','retrying','cancelled','failed','timed_out')
    when 'verifying' then to_status in ('completed','retrying','failed','cancelled')
    when 'retrying' then to_status in ('planning','running','verifying','failed','cancelled','timed_out')
    else false
  end
$$;
revoke all on function internal.run_transition_allowed(internal.run_status, internal.run_status) from public, anon, authenticated;
grant execute on function internal.run_transition_allowed(internal.run_status, internal.run_status) to service_role;

create or replace function public.cancel_agent_run(target_run_id uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare changed boolean;
begin
  update internal.agent_runs r set cancel_requested_at = now(), status = 'cancelled', finished_at = now(), updated_at = now()
  where r.id = target_run_id and (r.requested_by = (select auth.uid()) or internal.is_superadmin()) and r.status not in ('completed','failed','cancelled','timed_out') returning true into changed;
  if changed then update internal.job_queue set status = 'cancelled', leased_until = null, updated_at = now() where run_id = target_run_id and status not in ('completed','failed','cancelled','timed_out'); end if;
  return coalesce(changed, false);
end $$;
revoke all on function public.cancel_agent_run(uuid) from public;
grant execute on function public.cancel_agent_run(uuid) to authenticated;

create or replace function public.worker_is_agent_run_cancelled(target_run_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select cancel_requested_at is not null or status = 'cancelled' from internal.agent_runs where id = target_run_id), true) $$;
revoke all on function public.worker_is_agent_run_cancelled(uuid) from public, anon, authenticated;
grant execute on function public.worker_is_agent_run_cancelled(uuid) to service_role;

create or replace function public.worker_record_agent_step(target_run_id uuid, step_kind text, step_status text, summary text, state jsonb default '{}')
returns integer language plpgsql security definer set search_path = ''
as $$
declare sequence_number integer; current_status internal.run_status; desired_status internal.run_status := step_status::internal.run_status;
begin
  select status into current_status from internal.agent_runs where id = target_run_id for update;
  if current_status is null then raise exception 'run_not_found'; end if;
  if not internal.run_transition_allowed(current_status, desired_status) then raise exception 'invalid_run_transition:%->%', current_status, desired_status; end if;
  select coalesce(max(s.sequence_no), 0) + 1 into sequence_number from internal.agent_steps s where s.run_id = target_run_id;
  insert into internal.agent_steps(run_id, sequence_no, kind, status, input) values (target_run_id, sequence_number, step_kind, desired_status, jsonb_build_object('summary', summary));
  insert into internal.agent_checkpoints(run_id, step_sequence, state) values (target_run_id, sequence_number, state || jsonb_build_object('status', step_status));
  update internal.agent_runs set status = desired_status, active_skill = case when step_kind = 'skill' then summary else active_skill end, updated_at = now() where id = target_run_id;
  return sequence_number;
end $$;
revoke all on function public.worker_record_agent_step(uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.worker_record_agent_step(uuid,text,text,text,jsonb) to service_role;

create or replace function public.worker_complete_agent_run(target_run_id uuid, target_job_id uuid, output_content text, model_version uuid default null, usage jsonb default '{}')
returns void language plpgsql security definer set search_path = ''
as $$
declare conv_id uuid; org_id uuid; actor_id uuid; req_id text; tr_id text; current_status internal.run_status; resolved_model_version uuid;
begin
  select r.conversation_id, r.organization_id, r.requested_by, r.request_id, r.trace_id, r.status, coalesce(model_version, ma.model_version_id)
  into conv_id, org_id, actor_id, req_id, tr_id, current_status, resolved_model_version
  from internal.agent_runs r left join internal.model_aliases ma on ma.alias = r.model_alias where r.id = target_run_id for update of r;
  if current_status <> 'verifying' then raise exception 'run_not_verifying'; end if;
  insert into public.messages(conversation_id, role, content, model_version_id) values (conv_id, 'assistant', jsonb_build_object('text', output_content), resolved_model_version);
  update internal.agent_runs set status = 'completed', finished_at = now(), updated_at = now(), active_skill = null where id = target_run_id;
  update internal.job_queue set status = 'completed', leased_until = null, updated_at = now() where id = target_job_id and run_id = target_run_id;
  insert into internal.usage_events(organization_id,user_id,run_id,model_version_id,input_tokens,output_tokens,cached_tokens,gpu_seconds,queue_ms) values (org_id,actor_id,target_run_id,resolved_model_version,coalesce((usage->>'inputTokens')::bigint,0),coalesce((usage->>'outputTokens')::bigint,0),coalesce((usage->>'cachedTokens')::bigint,0),coalesce((usage->>'gpuSeconds')::numeric,0),coalesce((usage->>'queueMs')::integer,0));
  insert into audit.audit_events(organization_id,actor_user_id,request_id,trace_id,event_type,target_type,target_id,outcome) values (org_id,actor_id,req_id,tr_id,'agent.run.completed','agent_run',target_run_id::text,'success');
end $$;
revoke all on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) to service_role;

commit;
