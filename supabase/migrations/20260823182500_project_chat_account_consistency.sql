begin;

-- Project/chat identity is immutable after creation. A conversation belongs to
-- exactly one physical project/workspace/mode for its full lifetime. Standalone
-- chats continue to use the hidden standalone project internally.

do $$
begin
  if exists (
    select 1
    from public.conversations c
    left join public.projects p on p.id = c.project_id
    where c.project_id is not null
      and (p.id is null or p.workspace_id is distinct from c.workspace_id or p.mode is distinct from c.mode)
  ) then
    raise exception 'existing_conversation_project_invariant_violation';
  end if;
end $$;

create unique index if not exists projects_id_workspace_unique_idx
  on public.projects(id, workspace_id);

alter table public.conversations
  drop constraint if exists conversations_project_workspace_fk;
alter table public.conversations
  add constraint conversations_project_workspace_fk
  foreign key (project_id, workspace_id)
  references public.projects(id, workspace_id)
  on update restrict
  on delete restrict;

create or replace function internal.enforce_project_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.created_by is distinct from old.created_by
     or new.mode is distinct from old.mode
     or new.system_kind is distinct from old.system_kind then
    raise exception 'project_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.enforce_conversation_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.project_id is distinct from old.project_id
     or new.created_by is distinct from old.created_by
     or new.mode is distinct from old.mode then
    raise exception 'conversation_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.enforce_message_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.conversation_id is distinct from old.conversation_id
     or new.actor_user_id is distinct from old.actor_user_id
     or new.role is distinct from old.role then
    raise exception 'message_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_identity_immutable on public.projects;
create trigger projects_identity_immutable
before update on public.projects
for each row execute function internal.enforce_project_identity_immutable();

drop trigger if exists conversations_identity_immutable on public.conversations;
create trigger conversations_identity_immutable
before update on public.conversations
for each row execute function internal.enforce_conversation_identity_immutable();

drop trigger if exists messages_identity_immutable on public.messages;
create trigger messages_identity_immutable
before update on public.messages
for each row execute function internal.enforce_message_identity_immutable();

-- Reversible account pause is separate from organization suspension. It blocks
-- ordinary workspace/org access without destroying memberships, so resume is
-- deterministic and does not reconstruct permissions from guesses.
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
grant execute on function internal.is_account_active(uuid) to authenticated, service_role;

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

-- Authenticated users may edit only benign profile presentation fields directly.
-- Lifecycle fields are writable only through the state-machine RPC above.
revoke update on public.profiles from authenticated;
grant update(display_name, avatar_path) on public.profiles to authenticated;

-- Organization subscriptions use a provider-confirmed state machine. User actions
-- never claim that billing changed before the external billing provider confirms it.
create table if not exists public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  provider text not null,
  provider_subscription_id text,
  status text not null default 'inactive' check (status in (
    'inactive','trialing','active','pause_requested','paused','resume_requested','past_due','canceled'
  )),
  provider_status text,
  requested_action text check (requested_action is null or requested_action in ('pause','resume')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz,
  pause_effective_at timestamptz,
  current_period_end timestamptz,
  last_provider_event_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (requested_action is null and requested_by is null and requested_at is null)
    or (requested_action is not null and requested_by is not null and requested_at is not null)
  )
);

create unique index if not exists organization_subscriptions_provider_external_idx
  on public.organization_subscriptions(provider, provider_subscription_id)
  where provider_subscription_id is not null;
create index if not exists organization_subscriptions_status_idx
  on public.organization_subscriptions(status, updated_at desc);

alter table public.organization_subscriptions enable row level security;
create policy organization_subscriptions_member_select
  on public.organization_subscriptions
  for select to authenticated
  using (internal.is_org_member(organization_id));

revoke all on public.organization_subscriptions from anon, authenticated;
grant select on public.organization_subscriptions to authenticated;
grant all on public.organization_subscriptions to service_role;

create or replace function public.my_subscription_snapshot(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  subscription_row public.organization_subscriptions%rowtype;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id = target_workspace_id
    and internal.is_workspace_member(w.id);
  if org_id is null then
    raise exception 'workspace_access_denied' using errcode='42501';
  end if;

  select * into subscription_row
  from public.organization_subscriptions s
  where s.organization_id = org_id;

  if subscription_row.id is null then
    return jsonb_build_object('configured', false, 'status', 'inactive');
  end if;

  return jsonb_build_object(
    'configured', true,
    'id', subscription_row.id,
    'provider', subscription_row.provider,
    'status', subscription_row.status,
    'providerStatus', subscription_row.provider_status,
    'requestedAction', subscription_row.requested_action,
    'requestedAt', subscription_row.requested_at,
    'pauseEffectiveAt', subscription_row.pause_effective_at,
    'currentPeriodEnd', subscription_row.current_period_end,
    'updatedAt', subscription_row.updated_at
  );
end;
$$;

create or replace function public.request_my_subscription_action(
  target_workspace_id uuid,
  target_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  normalized_action text := lower(trim(coalesce(target_action,'')));
  subscription_row public.organization_subscriptions%rowtype;
  next_status text;
  changed boolean := false;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;
  if normalized_action not in ('pause','resume') then
    raise exception 'subscription_action_not_allowed';
  end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id = target_workspace_id
    and internal.is_workspace_member(w.id);
  if org_id is null then
    raise exception 'workspace_access_denied' using errcode='42501';
  end if;

  if not internal.is_superadmin() and not exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.organization_id = org_id
      and ur.user_id = actor_id
      and r.key = 'organization_admin'
  ) then
    raise exception 'subscription_manage_permission_denied' using errcode='42501';
  end if;

  select * into subscription_row
  from public.organization_subscriptions s
  where s.organization_id = org_id
  for update;

  if subscription_row.id is null then
    raise exception 'subscription_not_configured';
  end if;

  if normalized_action = 'pause' then
    if subscription_row.status in ('pause_requested','paused') then
      return jsonb_build_object('changed', false, 'status', subscription_row.status, 'requestedAction', subscription_row.requested_action);
    end if;
    if subscription_row.status not in ('active','trialing') then
      raise exception 'subscription_pause_invalid_from_status_%', subscription_row.status;
    end if;
    next_status := 'pause_requested';
  else
    if subscription_row.status in ('resume_requested','active','trialing') then
      return jsonb_build_object('changed', false, 'status', subscription_row.status, 'requestedAction', subscription_row.requested_action);
    end if;
    if subscription_row.status <> 'paused' then
      raise exception 'subscription_resume_invalid_from_status_%', subscription_row.status;
    end if;
    next_status := 'resume_requested';
  end if;

  update public.organization_subscriptions
  set status = next_status,
      requested_action = normalized_action,
      requested_by = actor_id,
      requested_at = now(),
      last_error_code = null,
      updated_at = now()
  where id = subscription_row.id;
  changed := true;

  insert into audit.audit_events(
    organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    org_id, actor_id, 'subscription.' || normalized_action || '.requested',
    'subscription', subscription_row.id::text, 'completed',
    jsonb_build_object('previousStatus', subscription_row.status, 'newStatus', next_status, 'provider', subscription_row.provider)
  );

  return jsonb_build_object('changed', changed, 'status', next_status, 'requestedAction', normalized_action);
end;
$$;

create or replace function public.service_confirm_subscription_status(
  target_subscription_id uuid,
  target_status text,
  target_provider_status text default null,
  target_effective_at timestamptz default null,
  target_provider_event_id text default null,
  target_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_status text := lower(trim(coalesce(target_status,'')));
  subscription_row public.organization_subscriptions%rowtype;
  clear_request boolean;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if normalized_status not in ('trialing','active','paused','past_due','canceled') then
    raise exception 'provider_subscription_status_not_allowed';
  end if;

  select * into subscription_row
  from public.organization_subscriptions s
  where s.id = target_subscription_id
  for update;
  if subscription_row.id is null then
    raise exception 'subscription_not_found';
  end if;

  if target_provider_event_id is not null
     and subscription_row.last_provider_event_id = target_provider_event_id then
    return jsonb_build_object('changed', false, 'status', subscription_row.status);
  end if;

  clear_request := normalized_status in ('trialing','active','paused','past_due','canceled');

  update public.organization_subscriptions
  set status = normalized_status,
      provider_status = target_provider_status,
      pause_effective_at = case
        when normalized_status = 'paused' then coalesce(target_effective_at, now())
        when normalized_status in ('active','trialing') then null
        else pause_effective_at
      end,
      requested_action = case when clear_request then null else requested_action end,
      requested_by = case when clear_request then null else requested_by end,
      requested_at = case when clear_request then null else requested_at end,
      last_provider_event_id = coalesce(target_provider_event_id,last_provider_event_id),
      last_error_code = target_error_code,
      updated_at = now()
  where id = subscription_row.id;

  insert into audit.audit_events(
    organization_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    subscription_row.organization_id, 'subscription.provider.confirmed',
    'subscription', subscription_row.id::text, 'completed',
    jsonb_build_object('previousStatus', subscription_row.status, 'newStatus', normalized_status, 'providerStatus', target_provider_status)
  );

  return jsonb_build_object('changed', true, 'status', normalized_status);
end;
$$;

revoke all on function public.my_subscription_snapshot(uuid), public.request_my_subscription_action(uuid,text) from public, anon;
grant execute on function public.my_subscription_snapshot(uuid), public.request_my_subscription_action(uuid,text) to authenticated;
revoke all on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,text) to service_role;

commit;
