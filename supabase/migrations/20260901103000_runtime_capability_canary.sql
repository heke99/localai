begin;

create or replace function public.service_runtime_canary_target()
returns uuid
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  target uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  select r.id into target
  from internal.agent_runs r
  order by r.created_at desc
  limit 1;
  if target is null then raise exception 'runtime_canary_agent_run_unavailable'; end if;
  return target;
end
$$;

revoke all on function public.service_runtime_canary_target() from public, anon, authenticated;
grant execute on function public.service_runtime_canary_target() to service_role;

create or replace function public.service_delete_runtime_canary_tool_execution(
  target_operation_id text
)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  removed integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if coalesce(target_operation_id,'') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_operation_id'; end if;

  delete from internal.agent_tool_executions e
  where e.operation_id = target_operation_id
    and e.tool_call_id like 'runtime-canary-%'
    and e.tool_name = 'current_time';
  get diagnostics removed = row_count;
  return removed > 0;
end
$$;

revoke all on function public.service_delete_runtime_canary_tool_execution(text) from public, anon, authenticated;
grant execute on function public.service_delete_runtime_canary_tool_execution(text) to service_role;

notify pgrst, 'reload schema';

commit;
