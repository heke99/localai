begin;

drop function if exists public.get_agent_run(uuid);
create function public.get_agent_run(target_run_id uuid)
returns table (id uuid, status text, mode text, model_alias text, failure_code text, cancel_requested_at timestamptz, created_at timestamptz, updated_at timestamptz, output_content text)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.status::text, r.mode, r.model_alias, r.failure_code, r.cancel_requested_at, r.created_at, r.updated_at,
    (select m.content->>'text' from public.messages m where m.conversation_id = r.conversation_id and m.role = 'assistant' order by m.created_at desc limit 1)
  from internal.agent_runs r
  where r.id = target_run_id and (r.requested_by = (select auth.uid()) or internal.is_superadmin())
$$;
revoke all on function public.get_agent_run(uuid) from public;
grant execute on function public.get_agent_run(uuid) to authenticated;

commit;
