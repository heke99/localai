drop function if exists public.worker_claim_agent_run(text);
create function public.worker_claim_agent_run(worker_id text)
returns table(job_id uuid,run_id uuid,conversation_id uuid,organization_id uuid,requested_by uuid,mode text,model_alias text,prompt text,request_id text,trace_id text,resource_context jsonb)
language plpgsql security definer set search_path=''
as $$
declare claimed_job internal.job_queue%rowtype;
begin
  select * into claimed_job from internal.job_queue q where q.queue='agent-runs' and q.status in ('queued','retrying') and q.available_at<=now() and (q.leased_until is null or q.leased_until<now()) order by q.priority asc,q.created_at asc for update skip locked limit 1;
  if claimed_job.id is null then return; end if;
  update internal.job_queue q set status='running',leased_by=worker_id,leased_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() where q.id=claimed_job.id;
  update internal.agent_runs r set status='planning',started_at=coalesce(started_at,now()),updated_at=now() where r.id=claimed_job.run_id and r.status in ('queued','retrying');
  return query select claimed_job.id,r.id,r.conversation_id,r.organization_id,r.requested_by,r.mode,r.model_alias,coalesce(m.content->>'text',''),r.request_id,r.trace_id,r.resource_context from internal.agent_runs r left join lateral(select msg.content from public.messages msg where msg.conversation_id=r.conversation_id and msg.role='user' order by msg.created_at desc limit 1)m on true where r.id=claimed_job.run_id;
end $$;
revoke all on function public.worker_claim_agent_run(text) from public,anon,authenticated;
grant execute on function public.worker_claim_agent_run(text) to service_role;
