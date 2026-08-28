begin;

-- Keep privileged access to internal.agent_runs behind a narrowly scoped,
-- authenticated function. The public Data API wrapper remains security invoker;
-- callers never receive table privileges on the internal queue/run tables.
create or replace function internal.get_active_agent_run_for_conversation(target_conversation_id uuid)
returns table(
  id uuid,
  status text,
  mode text,
  model_alias text,
  failure_code text,
  conversation_id uuid,
  input_message_id uuid,
  output_message_id uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.conversations c
    where c.id = target_conversation_id
      and internal.is_workspace_member(c.workspace_id)
  ) then
    raise exception 'conversation_access_denied' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.status::text,
    r.mode,
    r.model_alias,
    r.failure_code,
    r.conversation_id,
    r.input_message_id,
    r.output_message_id,
    r.created_at
  from internal.agent_runs r
  where r.conversation_id = target_conversation_id
    and r.requested_by = actor_id
    and r.status in ('queued','retrying','planning','running','waiting_for_tool','verifying')
  order by r.created_at desc
  limit 1;
end;
$$;

revoke all on function internal.get_active_agent_run_for_conversation(uuid) from public, anon, authenticated, service_role;
grant execute on function internal.get_active_agent_run_for_conversation(uuid) to authenticated, service_role;

-- USAGE only permits resolving names in the private schema. No table privilege is
-- granted; authenticated users still cannot select from internal.agent_runs.
grant usage on schema internal to authenticated, service_role;

create or replace function public.get_active_agent_run(target_conversation_id uuid)
returns table(
  id uuid,
  status text,
  mode text,
  model_alias text,
  failure_code text,
  conversation_id uuid,
  input_message_id uuid,
  output_message_id uuid,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from internal.get_active_agent_run_for_conversation(target_conversation_id);
$$;

revoke all on function public.get_active_agent_run(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_active_agent_run(uuid) to authenticated, service_role;

commit;
