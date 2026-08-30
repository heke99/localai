begin;

-- Extend the existing authenticated run stream with the latest recorded worker
-- step. The API layer is responsible for reducing this internal state to a
-- small user-safe activity label/target before it reaches the browser.
drop function if exists public.get_agent_run_stream(uuid);
create function public.get_agent_run_stream(target_run_id uuid)
returns table (
  id uuid,
  conversation_id uuid,
  status text,
  stream_content text,
  stream_revision bigint,
  updated_at timestamptz,
  activity_kind text,
  activity_status text,
  activity_summary text,
  activity_state jsonb
)
language sql stable security definer set search_path = ''
as $$
  select
    r.id,
    r.conversation_id,
    r.status::text,
    r.stream_content,
    r.stream_revision,
    r.updated_at,
    latest.kind,
    latest.step_status,
    latest.summary,
    latest.state
  from internal.agent_runs r
  left join lateral (
    select
      s.kind,
      s.status::text as step_status,
      nullif(s.input->>'summary', '') as summary,
      coalesce(c.state, '{}'::jsonb) as state
    from internal.agent_steps s
    left join internal.agent_checkpoints c
      on c.run_id = s.run_id
     and c.step_sequence = s.sequence_no
    where s.run_id = r.id
    order by s.sequence_no desc
    limit 1
  ) latest on true
  where r.id = target_run_id
    and (r.requested_by = (select auth.uid()) or internal.is_superadmin())
$$;

revoke all on function public.get_agent_run_stream(uuid) from public;
grant execute on function public.get_agent_run_stream(uuid) to authenticated;

commit;
