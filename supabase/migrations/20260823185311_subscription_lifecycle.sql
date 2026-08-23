begin;

-- Billing state is provider-confirmed. User actions create requests; they never
-- pretend an external subscription changed before the provider confirms it.
create table if not exists public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  provider text not null check (length(trim(provider)) between 1 and 64),
  provider_subscription_id text,
  status text not null default 'inactive' check (status in (
    'inactive','trialing','active','pause_requested','paused','resume_requested','past_due','canceled'
  )),
  provider_status text,
  requested_action text check (requested_action is null or requested_action in ('pause','resume')),
  requested_by uuid references auth.users(id) on delete restrict,
  requested_at timestamptz,
  pause_effective_at timestamptz,
  current_period_end timestamptz,
  last_provider_event_id text,
  last_provider_event_at timestamptz,
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

create table if not exists internal.subscription_provider_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.organization_subscriptions(id) on delete cascade,
  provider text not null,
  provider_event_id text not null,
  provider_event_at timestamptz not null,
  provider_status text,
  outcome text not null check (outcome in ('applied','duplicate','stale')),
  received_at timestamptz not null default now(),
  unique(provider, provider_event_id)
);
create index if not exists subscription_provider_events_subscription_time_idx
  on internal.subscription_provider_events(subscription_id, provider_event_at desc);
alter table internal.subscription_provider_events enable row level security;
grant all on public.organization_subscriptions, internal.subscription_provider_events to service_role;

alter table public.organization_subscriptions enable row level security;
drop policy if exists organization_subscriptions_member_select on public.organization_subscriptions;
create policy organization_subscriptions_member_select
  on public.organization_subscriptions
  for select to authenticated
  using (internal.is_org_member(organization_id));

revoke all on public.organization_subscriptions from anon, authenticated;
grant select on public.organization_subscriptions to authenticated;

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
    'lastErrorCode', subscription_row.last_error_code,
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
    if subscription_row.requested_action = 'pause'
       or subscription_row.status in ('pause_requested','paused') then
      return jsonb_build_object('changed', false, 'status', subscription_row.status, 'requestedAction', subscription_row.requested_action);
    end if;
    if subscription_row.status not in ('active','trialing') then
      raise exception 'subscription_pause_invalid_from_status_%', subscription_row.status;
    end if;
    next_status := 'pause_requested';
  else
    if subscription_row.requested_action = 'resume'
       or subscription_row.status in ('resume_requested','active','trialing') then
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

  insert into audit.audit_events(
    organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    org_id, actor_id, 'subscription.' || normalized_action || '.requested',
    'subscription', subscription_row.id::text, 'completed',
    jsonb_build_object('previousStatus', subscription_row.status, 'newStatus', next_status, 'provider', subscription_row.provider)
  );

  return jsonb_build_object('changed', true, 'status', next_status, 'requestedAction', normalized_action);
end;
$$;

create or replace function public.service_confirm_subscription_status(
  target_subscription_id uuid,
  target_status text,
  target_provider_status text default null,
  target_effective_at timestamptz default null,
  target_provider_event_id text default null,
  target_provider_event_at timestamptz default null,
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
  event_time timestamptz := coalesce(target_provider_event_at, now());
  next_status text;
  clear_request boolean := false;
  inserted_event uuid;
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

  if target_provider_event_id is not null then
    insert into internal.subscription_provider_events(
      subscription_id, provider, provider_event_id, provider_event_at, provider_status, outcome
    ) values (
      subscription_row.id, subscription_row.provider, target_provider_event_id, event_time, target_provider_status, 'applied'
    )
    on conflict (provider, provider_event_id) do nothing
    returning id into inserted_event;

    if inserted_event is null then
      return jsonb_build_object('changed', false, 'status', subscription_row.status, 'reason', 'duplicate_provider_event');
    end if;
  end if;

  if subscription_row.last_provider_event_at is not null
     and event_time < subscription_row.last_provider_event_at then
    if inserted_event is not null then
      update internal.subscription_provider_events set outcome='stale' where id=inserted_event;
    end if;
    return jsonb_build_object('changed', false, 'status', subscription_row.status, 'reason', 'stale_provider_event');
  end if;

  next_status := normalized_status;
  if subscription_row.requested_action = 'pause' then
    if normalized_status = 'paused' then
      clear_request := true;
    elsif normalized_status = 'canceled' then
      clear_request := true;
    elsif normalized_status in ('active','trialing') then
      next_status := 'pause_requested';
    end if;
  elsif subscription_row.requested_action = 'resume' then
    if normalized_status in ('active','trialing','canceled') then
      clear_request := true;
    elsif normalized_status = 'paused' then
      next_status := 'resume_requested';
    end if;
  else
    clear_request := true;
  end if;

  update public.organization_subscriptions
  set status = next_status,
      provider_status = target_provider_status,
      pause_effective_at = case
        when normalized_status = 'paused' then coalesce(target_effective_at, event_time)
        when normalized_status in ('active','trialing') then null
        else pause_effective_at
      end,
      requested_action = case when clear_request then null else requested_action end,
      requested_by = case when clear_request then null else requested_by end,
      requested_at = case when clear_request then null else requested_at end,
      last_provider_event_id = coalesce(target_provider_event_id,last_provider_event_id),
      last_provider_event_at = greatest(coalesce(last_provider_event_at, event_time), event_time),
      last_error_code = target_error_code,
      updated_at = now()
  where id = subscription_row.id;

  insert into audit.audit_events(
    organization_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    subscription_row.organization_id, 'subscription.provider.confirmed',
    'subscription', subscription_row.id::text, 'completed',
    jsonb_build_object(
      'previousStatus', subscription_row.status,
      'newStatus', next_status,
      'providerStatus', target_provider_status,
      'providerEventId', target_provider_event_id
    )
  );

  return jsonb_build_object('changed', true, 'status', next_status, 'requestedAction', case when clear_request then null else subscription_row.requested_action end);
end;
$$;

revoke all on function public.my_subscription_snapshot(uuid) from public, anon;
revoke all on function public.request_my_subscription_action(uuid,text) from public, anon;
grant execute on function public.my_subscription_snapshot(uuid) to authenticated;
grant execute on function public.request_my_subscription_action(uuid,text) to authenticated;

revoke all on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,timestamptz,text) to service_role;

commit;
