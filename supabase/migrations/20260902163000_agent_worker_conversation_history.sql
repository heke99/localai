begin;

-- Agent execution must see the preceding conversation turns just like direct
-- inference does. Keep claim/lease semantics untouched and expose history through
-- a separate service-role-only RPC keyed by the immutable run request identity.
create or replace function public.worker_load_agent_conversation_history(
  target_request_id text,
  target_limit integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_run internal.agent_runs%rowtype;
  input_created_at timestamptz;
  bounded_limit integer := least(greatest(coalesce(target_limit, 60), 0), 80);
  result jsonb;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  if nullif(trim(coalesce(target_request_id, '')), '') is null then
    raise exception 'request_id_required';
  end if;

  select r.* into target_run
  from internal.agent_runs r
  where r.request_id = target_request_id
  limit 1;

  if target_run.id is null then
    raise exception 'agent_run_not_found';
  end if;

  select m.created_at into input_created_at
  from public.messages m
  where m.id = target_run.input_message_id
    and m.conversation_id = target_run.conversation_id
    and m.role = 'user';

  if input_created_at is null then
    raise exception 'agent_run_input_message_mismatch';
  end if;

  if bounded_limit = 0 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('role', h.role, 'content', h.content) order by h.created_at asc, h.id asc), '[]'::jsonb)
  into result
  from (
    select m.id,
           m.role,
           coalesce(m.content->>'text', '') as content,
           m.created_at
    from public.messages m
    where m.conversation_id = target_run.conversation_id
      and m.id <> target_run.input_message_id
      and m.role in ('user', 'assistant')
      and nullif(trim(coalesce(m.content->>'text', '')), '') is not null
      and (m.created_at < input_created_at or (m.created_at = input_created_at and m.id < target_run.input_message_id))
    order by m.created_at desc, m.id desc
    limit bounded_limit
  ) h;

  return coalesce(result, '[]'::jsonb);
end;
$$;

revoke all on function public.worker_load_agent_conversation_history(text, integer) from public, anon, authenticated;
grant execute on function public.worker_load_agent_conversation_history(text, integer) to service_role;

commit;
