begin;

create or replace function public.worker_fail_agent_run(target_run_id uuid, target_job_id uuid, error_code text, retryable boolean default false)
returns void language plpgsql security definer set search_path = ''
as $$
declare next_status internal.run_status; current_status internal.run_status; job_attempts integer; max_attempts integer;
begin
  select status into current_status from internal.agent_runs where id = target_run_id for update;
  select attempts, maximum_attempts into job_attempts, max_attempts from internal.job_queue where id = target_job_id for update;
  if current_status = 'cancelled' then
    update internal.job_queue set status = 'cancelled', leased_until = null, updated_at = now() where id = target_job_id;
    return;
  end if;
  next_status := case when retryable and job_attempts < max_attempts then 'retrying'::internal.run_status else 'failed'::internal.run_status end;
  if not internal.run_transition_allowed(current_status, next_status) then raise exception 'invalid_run_transition:%->%', current_status, next_status; end if;
  update internal.agent_runs set status = next_status, failure_code = left(error_code,160), finished_at = case when next_status = 'failed' then now() else null end, updated_at = now() where id = target_run_id;
  update internal.job_queue set status = next_status, last_error_code = left(error_code,160), available_at = case when next_status = 'retrying' then now() + make_interval(secs => least(60, power(2, job_attempts)::integer)) else available_at end, leased_until = null, updated_at = now() where id = target_job_id;
end $$;
revoke all on function public.worker_fail_agent_run(uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.worker_fail_agent_run(uuid,uuid,text,boolean) to service_role;

commit;
