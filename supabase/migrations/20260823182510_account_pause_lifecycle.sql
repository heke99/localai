begin;

-- Account pause is a reversible access state. It never deletes workspace/project data
-- or memberships, which makes resume deterministic.
alter table public.profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists account_paused_at timestamptz,
  add column if not exists account_status_changed_at timestamptz not null default now();

alter table public.profiles drop constraint if exists profiles_account_status_check;
alter table public.profiles add constraint profiles_account_status_check
  check (account_status in ('active','paused'));

alter table public.profiles drop constraint if exists profiles_account_pause_timestamp_check;
alter table public.profiles add constraint profiles_account_pause_timestamp_check
  check (
    (account_status = 'active' and account_paused_at is null)
    or (account_status = 'paused' and account_paused_at is not null)
  );

create or replace function internal.is_account_active(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin()
    or exists (
      select 1
      from public.profiles p
      where p.user_id = target_user_id
        and p.account_status = 'active'
    )
$$;

-- Central membership predicates now also enforce the account lifecycle state. Every
-- policy/RPC that already depends on these helpers inherits pause behavior uniformly.
create or replace function internal.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin()
    or (
      internal.is_account_active((select auth.uid()))
      and exists (
        select 1
        from public.organization_members m
        where m.organization_id = org_id
          and m.user_id = (select auth.uid())
          and m.status = 'active'
      )
    )
$$;

create or replace function internal.is_workspace_member(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin()
    or (
      internal.is_account_active((select auth.uid()))
      and exists (
        select 1
        from public.workspace_members m
        where m.workspace_id = ws_id
          and m.user_id = (select auth.uid())
      )
    )
$$;

revoke all on function internal.is_account_active(uuid) from public, anon;
revoke all on function internal.is_org_member(uuid) from public, anon;
revoke all on function internal.is_workspace_member(uuid) from public, anon;
grant execute on function internal.is_account_active(uuid) to authenticated, service_role;
grant execute on function internal.is_org_member(uuid) to authenticated, service_role;
grant execute on function internal.is_workspace_member(uuid) to authenticated, service_role;

create or replace function public.set_my_account_status(target_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  normalized_status text := lower(trim(coalesce(target_status, '')));
  current_status text;
  changed boolean := false;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if normalized_status not in ('active','paused') then
    raise exception 'account_status_not_allowed';
  end if;
  if internal.is_superadmin() and normalized_status = 'paused' then
    raise exception 'superadmin_account_pause_not_allowed' using errcode = '42501';
  end if;

  select p.account_status into current_status
  from public.profiles p
  where p.user_id = actor_id
  for update;

  if current_status is null then
    raise exception 'profile_not_found';
  end if;

  if current_status is distinct from normalized_status then
    update public.profiles
    set account_status = normalized_status,
        account_paused_at = case when normalized_status = 'paused' then now() else null end,
        account_status_changed_at = now(),
        updated_at = now()
    where user_id = actor_id;
    changed := true;

    insert into audit.audit_events(
      actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
    ) values (
      actor_id,
      case when normalized_status = 'paused' then 'account.paused' else 'account.resumed' end,
      'user', actor_id::text, 'completed',
      jsonb_build_object('previousStatus', current_status, 'newStatus', normalized_status)
    );
  end if;

  return jsonb_build_object(
    'status', normalized_status,
    'changed', changed,
    'pausedAt', (
      select p.account_paused_at from public.profiles p where p.user_id = actor_id
    )
  );
end;
$$;

revoke all on function public.set_my_account_status(text) from public, anon;
grant execute on function public.set_my_account_status(text) to authenticated;

-- Lifecycle fields are state-machine owned. Authenticated users retain only benign
-- presentation updates; service-role/admin RPCs are unaffected.
revoke update on public.profiles from authenticated;
grant update(display_name, avatar_path) on public.profiles to authenticated;

commit;
