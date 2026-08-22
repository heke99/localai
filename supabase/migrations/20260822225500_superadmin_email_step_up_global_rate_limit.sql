alter table internal.superadmin_email_step_up_sessions
  add column if not exists challenge_sent_at timestamptz;

create table if not exists internal.superadmin_email_step_up_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  failed_attempts integer not null default 0 check (failed_attempts >= 0 and failed_attempts <= 5),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table internal.superadmin_email_step_up_limits enable row level security;
revoke all on table internal.superadmin_email_step_up_limits from anon, authenticated;

create or replace function public.superadmin_email_step_up_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  state internal.superadmin_email_step_up_sessions%rowtype;
  global_locked_until timestamptz;
begin
  if actor_id is null or current_session_id is null or not internal.is_superadmin() then
    return jsonb_build_object('verified', false, 'reason', 'not_authorized');
  end if;

  select * into state
  from internal.superadmin_email_step_up_sessions s
  where s.session_id = current_session_id and s.user_id = actor_id;

  select l.locked_until into global_locked_until
  from internal.superadmin_email_step_up_limits l
  where l.user_id = actor_id and l.locked_until > now();

  return jsonb_build_object(
    'verified', coalesce(state.verified_until > now(), false),
    'verified_until', state.verified_until,
    'locked_until', global_locked_until,
    'failed_attempts', coalesce(state.failed_attempts, 0),
    'challenge_active', coalesce(state.challenge_sent_at >= now() - interval '5 minutes', false)
  );
end;
$$;

revoke all on function public.superadmin_email_step_up_status() from public, anon;
grant execute on function public.superadmin_email_step_up_status() to authenticated;

create or replace function public.superadmin_begin_email_step_up()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  global_locked_until timestamptz;
begin
  if actor_id is null or current_session_id is null or not internal.is_superadmin() then
    return jsonb_build_object('started', false, 'reason', 'not_authorized');
  end if;

  select l.locked_until into global_locked_until
  from internal.superadmin_email_step_up_limits l
  where l.user_id = actor_id and l.locked_until > now();

  if global_locked_until is not null then
    return jsonb_build_object('started', false, 'reason', 'locked', 'locked_until', global_locked_until);
  end if;

  insert into internal.superadmin_email_step_up_sessions(session_id, user_id, challenge_sent_at, updated_at)
  values (current_session_id, actor_id, now(), now())
  on conflict (session_id) do update
  set challenge_sent_at = excluded.challenge_sent_at,
      updated_at = now()
  where internal.superadmin_email_step_up_sessions.user_id = actor_id;

  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (actor_id,'auth.email_step_up.sent','session',current_session_id::text,'completed','{}'::jsonb);

  return jsonb_build_object('started', true, 'expires_at', now() + interval '5 minutes');
end;
$$;

revoke all on function public.superadmin_begin_email_step_up() from public, anon;
grant execute on function public.superadmin_begin_email_step_up() to authenticated;

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
  limiter internal.superadmin_email_step_up_limits%rowtype;
  next_attempts integer;
  valid_until timestamptz;
  lock_until timestamptz;
begin
  if actor_id is null or current_session_id is null or not internal.is_superadmin() then
    return jsonb_build_object('verified', false, 'reason', 'not_authorized');
  end if;

  if code is null or code !~ '^[0-9]{6}$' then
    return jsonb_build_object('verified', false, 'reason', 'invalid_code');
  end if;

  select * into state
  from internal.superadmin_email_step_up_sessions s
  where s.session_id = current_session_id and s.user_id = actor_id
  for update;

  if not found or state.challenge_sent_at is null or state.challenge_sent_at < now() - interval '5 minutes' then
    return jsonb_build_object('verified', false, 'reason', 'expired');
  end if;

  insert into internal.superadmin_email_step_up_limits(user_id)
  values (actor_id)
  on conflict (user_id) do nothing;

  select * into limiter
  from internal.superadmin_email_step_up_limits l
  where l.user_id = actor_id
  for update;

  if limiter.locked_until is not null and limiter.locked_until > now() then
    return jsonb_build_object('verified', false, 'reason', 'locked', 'locked_until', limiter.locked_until);
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
    if limiter.window_started_at < now() - interval '15 minutes' then
      next_attempts := 1;
      limiter.window_started_at := now();
    else
      next_attempts := least(limiter.failed_attempts + 1, 5);
    end if;

    lock_until := case when next_attempts >= 5 then now() + interval '15 minutes' else null end;

    update internal.superadmin_email_step_up_limits
    set failed_attempts = next_attempts,
        window_started_at = limiter.window_started_at,
        locked_until = lock_until,
        updated_at = now()
    where user_id = actor_id;

    update internal.superadmin_email_step_up_sessions
    set failed_attempts = least(failed_attempts + 1, 5),
        locked_until = lock_until,
        updated_at = now()
    where session_id = current_session_id;

    insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
    values (actor_id,'auth.email_step_up.failed','session',current_session_id::text,'rejected',jsonb_build_object('account_attempt',next_attempts));

    return jsonb_build_object(
      'verified', false,
      'reason', case when next_attempts >= 5 then 'locked' else 'invalid_code' end,
      'remaining_attempts', greatest(5 - next_attempts, 0),
      'locked_until', lock_until
    );
  end if;

  valid_until := now() + interval '12 hours';
  update internal.superadmin_email_step_up_sessions
  set verified_at = now(),
      verified_until = valid_until,
      failed_attempts = 0,
      locked_until = null,
      challenge_sent_at = null,
      updated_at = now()
  where session_id = current_session_id;

  update internal.superadmin_email_step_up_limits
  set failed_attempts = 0,
      window_started_at = now(),
      locked_until = null,
      updated_at = now()
  where user_id = actor_id;

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
