create table if not exists internal.superadmin_email_step_up_sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz,
  verified_until timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0 and failed_attempts <= 5),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists superadmin_email_step_up_sessions_user_id_idx
  on internal.superadmin_email_step_up_sessions(user_id);

alter table internal.superadmin_email_step_up_sessions enable row level security;
revoke all on table internal.superadmin_email_step_up_sessions from anon, authenticated;

create or replace function internal.is_superadmin_email_verified()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin()
    and exists (
      select 1
      from internal.superadmin_email_step_up_sessions s
      where s.user_id = auth.uid()
        and s.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
        and s.verified_until > now()
    )
$$;

revoke all on function internal.is_superadmin_email_verified() from public, anon, authenticated;

-- Compatibility shim for existing protected RPCs and RLS policies. The platform no longer
-- uses authenticator-app AAL2; privileged access is gated by the email step-up session.
create or replace function internal.is_superadmin_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin_email_verified()
$$;

revoke all on function internal.is_superadmin_aal2() from public, anon, authenticated;

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
begin
  if actor_id is null or current_session_id is null or not internal.is_superadmin() then
    return jsonb_build_object('verified', false, 'reason', 'not_authorized');
  end if;

  select * into state
  from internal.superadmin_email_step_up_sessions s
  where s.session_id = current_session_id and s.user_id = actor_id;

  return jsonb_build_object(
    'verified', coalesce(state.verified_until > now(), false),
    'verified_until', state.verified_until,
    'locked_until', case when state.locked_until > now() then state.locked_until else null end,
    'failed_attempts', coalesce(state.failed_attempts, 0)
  );
end;
$$;

revoke all on function public.superadmin_email_step_up_status() from public, anon;
grant execute on function public.superadmin_email_step_up_status() to authenticated;

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

  select lower(u.email), u.reauthentication_sent_at
    into normalized_email, sent_at
  from auth.users u
  where u.id = actor_id;

  if normalized_email is null or sent_at is null or sent_at < now() - interval '5 minutes' then
    return jsonb_build_object('verified', false, 'reason', 'expired');
  end if;

  expected_hash := encode(extensions.digest((normalized_email || code)::text, 'sha224'::text), 'hex');

  if not exists (
    select 1
    from auth.one_time_tokens ott
    where ott.user_id = actor_id
      and ott.token_type::text = 'reauthentication_token'
      and ott.token_hash = expected_hash
  ) then
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
