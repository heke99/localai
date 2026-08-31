begin;

create or replace function internal.enforce_conversation_execution_exclusivity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Both agent and direct inserts acquire the same transaction-scoped lock for
  -- the conversation. This closes the two-tab race where each path could observe
  -- the other table before either transaction had committed.
  perform pg_advisory_xact_lock(hashtextextended(new.conversation_id::text, 941731));

  if tg_table_name = 'agent_runs' then
    if exists (
      select 1
      from internal.direct_model_runs d
      where d.conversation_id = new.conversation_id
        and d.status = 'running'
    ) then
      raise exception 'conversation_has_active_run';
    end if;
  elsif tg_table_name = 'direct_model_runs' then
    if exists (
      select 1
      from internal.agent_runs a
      where a.conversation_id = new.conversation_id
        and a.status::text not in ('completed','failed','cancelled','timed_out')
    ) then
      raise exception 'conversation_has_active_run';
    end if;
  else
    raise exception 'unsupported_execution_table';
  end if;

  return new;
end;
$$;

revoke all on function internal.enforce_conversation_execution_exclusivity() from public, anon, authenticated;
grant execute on function internal.enforce_conversation_execution_exclusivity() to service_role;

-- The trigger itself executes as the table owner and does not expose the
-- internal table to authenticated clients.
drop trigger if exists agent_runs_conversation_execution_exclusivity on internal.agent_runs;
create trigger agent_runs_conversation_execution_exclusivity
before insert on internal.agent_runs
for each row execute function internal.enforce_conversation_execution_exclusivity();

drop trigger if exists direct_model_runs_conversation_execution_exclusivity on internal.direct_model_runs;
create trigger direct_model_runs_conversation_execution_exclusivity
before insert on internal.direct_model_runs
for each row execute function internal.enforce_conversation_execution_exclusivity();

commit;
