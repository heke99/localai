begin;

alter table internal.agent_runs
  add column if not exists stream_content text not null default '',
  add column if not exists stream_revision bigint not null default 0;

create or replace function public.worker_append_agent_run_stream(target_run_id uuid, delta text, reset_stream boolean default false)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare next_revision bigint;
begin
  if length(coalesce(delta, '')) > 20000 then
    raise exception 'stream_delta_too_large';
  end if;
  update internal.agent_runs r
  set stream_content = case when reset_stream then coalesce(delta, '') else left(r.stream_content || coalesce(delta, ''), 2000000) end,
      stream_revision = r.stream_revision + 1,
      updated_at = now()
  where r.id = target_run_id and r.status not in ('completed','failed','cancelled','timed_out')
  returning stream_revision into next_revision;
  if next_revision is null then raise exception 'stream_run_not_writable'; end if;
  return next_revision;
end $$;
revoke all on function public.worker_append_agent_run_stream(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.worker_append_agent_run_stream(uuid,text,boolean) to service_role;

drop function if exists public.get_agent_run_stream(uuid);
create function public.get_agent_run_stream(target_run_id uuid)
returns table (id uuid, conversation_id uuid, status text, stream_content text, stream_revision bigint, updated_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.conversation_id, r.status::text, r.stream_content, r.stream_revision, r.updated_at
  from internal.agent_runs r
  where r.id = target_run_id and (r.requested_by = (select auth.uid()) or internal.is_superadmin())
$$;
revoke all on function public.get_agent_run_stream(uuid) from public;
grant execute on function public.get_agent_run_stream(uuid) to authenticated;

create or replace function public.worker_complete_agent_run(target_run_id uuid, target_job_id uuid, output_content text, model_version uuid default null, usage jsonb default '{}')
returns void language plpgsql security definer set search_path = ''
as $$
declare conv_id uuid; org_id uuid; actor_id uuid; req_id text; tr_id text;
begin
  select conversation_id, organization_id, requested_by, request_id, trace_id into conv_id, org_id, actor_id, req_id, tr_id from internal.agent_runs where id = target_run_id for update;
  insert into public.messages(conversation_id, role, content, model_version_id) values (conv_id, 'assistant', jsonb_build_object('text', output_content), model_version);
  update internal.agent_runs set status = 'completed', stream_content = output_content, stream_revision = stream_revision + 1, finished_at = now(), updated_at = now(), active_skill = null where id = target_run_id;
  update internal.job_queue set status = 'completed', leased_until = null, updated_at = now() where id = target_job_id and run_id = target_run_id;
  insert into internal.usage_events(organization_id,user_id,run_id,model_version_id,input_tokens,output_tokens,cached_tokens,gpu_seconds,queue_ms)
  values (org_id,actor_id,target_run_id,model_version,coalesce((usage->>'inputTokens')::bigint,0),coalesce((usage->>'outputTokens')::bigint,0),coalesce((usage->>'cachedTokens')::bigint,0),coalesce((usage->>'gpuSeconds')::numeric,0),coalesce((usage->>'queueMs')::integer,0));
  insert into audit.audit_events(organization_id,actor_user_id,request_id,trace_id,event_type,target_type,target_id,outcome) values (org_id,actor_id,req_id,tr_id,'agent.run.completed','agent_run',target_run_id::text,'success');
end $$;
revoke all on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) to service_role;

commit;
