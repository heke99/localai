create or replace function public.superadmin_verify_email_code(code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  normalized_email text;
  sent_at timestamptz;
  stored_hash text;
  expected_hash text;
  state internal.superadmin_email_step_up_sessions%rowtype;
  next_attempts integer;
  valid_until timestamptz;
begin
  if actor_id is null or current_session_id is null or not internal.is_superadmin() then
    return jsonb_build_object('verified', false, 'reason', 'not_authorized');
  end if;

  if code is null or code !~ '^[0-9]{6}$' then
    return jsonb_build_object('verified', false, 'reason', 'invalid_code');
  end if;

  insert into internal.superadmin_email_step_up_sessions(session_id, user_id)
  values (current_session_id, actor_id)
  on conflict (session_id) do nothing;

  select * into state
  from internal.superadmin_email_step_up_sessions s
  where s.session_id = current_session_id and s.user_id = actor_id
  for update;

  if state.locked_until is not null and state.locked_until > now() then
    return jsonb_build_object('verified', false, 'reason', 'locked', 'locked_until', state.locked_until);
  end if;

  select lower(u.email), u.reauthentication_sent_at, u.reauthentication_token
    into normalized_email, sent_at, stored_hash
  from auth.users u
  where u.id = actor_id;

  if normalized_email is null or sent_at is null or stored_hash is null or stored_hash = ''
     or sent_at < now() - interval '5 minutes' then
    return jsonb_build_object('verified', false, 'reason', 'expired');
  end if;

  expected_hash := encode(extensions.digest((normalized_email || code)::text, 'sha224'::text), 'hex');

  if stored_hash <> expected_hash then
    next_attempts := least(coalesce(state.failed_attempts, 0) + 1, 5);
    update internal.superadmin_email_step_up_sessions
    set failed_attempts = next_attempts,
        locked_until = case when next_attempts >= 5 then now() + interval '15 minutes' else null end,
        updated_at = now()
    where session_id = current_session_id;

    insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
    values (actor_id,'auth.email_step_up.failed','session',current_session_id::text,'rejected',jsonb_build_object('attempt',next_attempts));

    return jsonb_build_object(
      'verified', false,
      'reason', case when next_attempts >= 5 then 'locked' else 'invalid_code' end,
      'remaining_attempts', greatest(5 - next_attempts, 0),
      'locked_until', case when next_attempts >= 5 then now() + interval '15 minutes' else null end
    );
  end if;

  valid_until := now() + interval '12 hours';
  update internal.superadmin_email_step_up_sessions
  set verified_at = now(),
      verified_until = valid_until,
      failed_attempts = 0,
      locked_until = null,
      updated_at = now()
  where session_id = current_session_id;

  delete from auth.one_time_tokens
  where user_id = actor_id and token_type::text = 'reauthentication_token';

  update auth.users
  set reauthentication_token = '', reauthentication_sent_at = null
  where id = actor_id;

  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (actor_id,'auth.email_step_up.verified','session',current_session_id::text,'completed',jsonb_build_object('verified_until',valid_until));

  return jsonb_build_object('verified', true, 'verified_until', valid_until);
end;
$$;

revoke all on function public.superadmin_verify_email_code(text) from public, anon;
grant execute on function public.superadmin_verify_email_code(text) to authenticated;
