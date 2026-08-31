begin;

create or replace function public.worker_claim_agent_tool_execution(
  target_run_id uuid,
  target_tool_call_id text,
  target_operation_id text,
  target_tool_name text,
  target_input_hash text,
  target_input_redacted jsonb default '{}'::jsonb,
  target_mutating boolean default false,
  target_reversible boolean default false,
  target_scope_snapshot jsonb default null
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  e internal.agent_tool_executions%rowtype;
  next_attempt integer;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if coalesce(target_operation_id,'') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_operation_id'; end if;

  insert into internal.agent_tool_executions(
    run_id,tool_call_id,operation_id,tool_name,status,attempt,input_hash,input_redacted,
    mutating,reversible,scope_snapshot
  ) values(
    target_run_id,target_tool_call_id,target_operation_id,target_tool_name,'queued',1,
    target_input_hash,coalesce(target_input_redacted,'{}'::jsonb),target_mutating,target_reversible,target_scope_snapshot
  ) on conflict do nothing;

  select * into e from internal.agent_tool_executions
  where operation_id=target_operation_id
  for update;
  if not found then raise exception 'tool_execution_claim_failed'; end if;
  if e.run_id<>target_run_id or e.tool_call_id<>target_tool_call_id or e.tool_name<>target_tool_name or e.input_hash<>target_input_hash then
    raise exception 'tool_operation_context_mismatch' using errcode='42501';
  end if;

  if e.status='completed' and e.mutating then
    return jsonb_build_object('executionId',e.id,'status','completed','executeAllowed',false,'replayed',true,'result',e.output_summary,'attempt',e.attempt);
  end if;
  if e.status in ('running','waiting','cancelling') then
    return jsonb_build_object('executionId',e.id,'status',e.status,'executeAllowed',false,'replayed',false,'attempt',e.attempt);
  end if;
  if e.status in ('cancelled','blocked') or (e.status='failed' and not e.retryable) then
    return jsonb_build_object('executionId',e.id,'status',e.status,'executeAllowed',false,'replayed',false,'attempt',e.attempt,'errorCode',e.error_code);
  end if;

  next_attempt := case
    when e.status in ('failed','completed') then e.attempt+1
    else greatest(e.attempt,1)
  end;
  update internal.agent_tool_executions
  set status='running',attempt=next_attempt,started_at=coalesce(started_at,now()),finished_at=null,
      error_code=null,retryable=false,updated_at=now()
  where id=e.id
  returning * into e;

  return jsonb_build_object('executionId',e.id,'status','running','executeAllowed',true,'replayed',false,'attempt',e.attempt);
end $$;

revoke all on function public.worker_claim_agent_tool_execution(uuid,text,text,text,text,jsonb,boolean,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.worker_claim_agent_tool_execution(uuid,text,text,text,text,jsonb,boolean,boolean,jsonb) to service_role;

commit;
