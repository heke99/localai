begin;

alter table public.organization_subscriptions
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists termination_intent text,
  add column if not exists renewal_action_requested text,
  add column if not exists renewal_action_requested_at timestamptz,
  add column if not exists renewal_action_requested_by uuid references auth.users(id) on delete set null,
  add column if not exists cancellation_reason text,
  add column if not exists canceled_at timestamptz,
  add column if not exists pause_collection_behavior text;

alter table public.organization_subscriptions drop constraint if exists organization_subscriptions_termination_intent_check;
alter table public.organization_subscriptions add constraint organization_subscriptions_termination_intent_check
  check (termination_intent is null or termination_intent in ('cancel','auto_renew_off'));

alter table public.organization_subscriptions drop constraint if exists organization_subscriptions_renewal_action_requested_check;
alter table public.organization_subscriptions add constraint organization_subscriptions_renewal_action_requested_check
  check (renewal_action_requested is null or renewal_action_requested in ('cancel','disable_auto_renew','reactivate'));

alter table public.organization_subscriptions drop constraint if exists organization_subscriptions_cancellation_reason_check;
alter table public.organization_subscriptions add constraint organization_subscriptions_cancellation_reason_check
  check (cancellation_reason is null or char_length(cancellation_reason) between 1 and 64);

-- User requests remain pending metadata only. Access changes only after the
-- external billing provider confirms the corresponding subscription state.
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
  if subscription_row.access_mode <> 'paid'
     or subscription_row.provider <> 'stripe'
     or subscription_row.provider_subscription_id is null then
    raise exception 'stripe_subscription_not_configured';
  end if;

  if normalized_action = 'pause' then
    if subscription_row.status = 'paused' then
      return jsonb_build_object(
        'changed', false,
        'status', subscription_row.status,
        'requestedAction', subscription_row.requested_action,
        'subscriptionId', subscription_row.id,
        'providerSubscriptionId', subscription_row.provider_subscription_id
      );
    end if;
    if subscription_row.status not in ('active','trialing') then
      raise exception 'subscription_pause_invalid_from_status_%', subscription_row.status;
    end if;
  else
    if subscription_row.status in ('active','trialing') then
      return jsonb_build_object(
        'changed', false,
        'status', subscription_row.status,
        'requestedAction', subscription_row.requested_action,
        'subscriptionId', subscription_row.id,
        'providerSubscriptionId', subscription_row.provider_subscription_id
      );
    end if;
    if subscription_row.status <> 'paused' then
      raise exception 'subscription_resume_invalid_from_status_%', subscription_row.status;
    end if;
  end if;

  if subscription_row.requested_action = normalized_action then
    return jsonb_build_object(
      'changed', false,
      'status', subscription_row.status,
      'requestedAction', subscription_row.requested_action,
      'subscriptionId', subscription_row.id,
      'providerSubscriptionId', subscription_row.provider_subscription_id
    );
  end if;

  update public.organization_subscriptions
  set requested_action = normalized_action,
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
    jsonb_build_object(
      'status', subscription_row.status,
      'provider', subscription_row.provider,
      'providerPending', true
    )
  );

  return jsonb_build_object(
    'changed', true,
    'status', subscription_row.status,
    'requestedAction', normalized_action,
    'subscriptionId', subscription_row.id,
    'providerSubscriptionId', subscription_row.provider_subscription_id
  );
end;
$$;

-- Keep pending requests from changing access when unrelated provider events
-- arrive. Only a matching provider-confirmed status clears the request.
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
    if normalized_status in ('paused','canceled') then
      clear_request := true;
    elsif normalized_status in ('active','trialing') then
      next_status := normalized_status;
    end if;
  elsif subscription_row.requested_action = 'resume' then
    if normalized_status in ('active','trialing','canceled') then
      clear_request := true;
    elsif normalized_status = 'paused' then
      next_status := 'paused';
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

  return jsonb_build_object(
    'changed', true,
    'status', next_status,
    'requestedAction', case when clear_request then null else subscription_row.requested_action end
  );
end;
$$;

create or replace function public.my_subscription_management_snapshot(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  can_manage boolean := false;
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

  can_manage := internal.is_superadmin() or exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.organization_id = org_id
      and ur.user_id = actor_id
      and r.key = 'organization_admin'
  );

  select * into subscription_row
  from public.organization_subscriptions s
  where s.organization_id = org_id;

  if subscription_row.id is null then
    return jsonb_build_object('configured', false, 'canManage', can_manage, 'status', 'inactive');
  end if;

  return jsonb_build_object(
    'configured', true,
    'canManage', can_manage,
    'id', subscription_row.id,
    'provider', subscription_row.provider,
    'providerSubscriptionId', subscription_row.provider_subscription_id,
    'status', subscription_row.status,
    'providerStatus', subscription_row.provider_status,
    'requestedAction', subscription_row.requested_action,
    'requestedAt', subscription_row.requested_at,
    'pauseEffectiveAt', subscription_row.pause_effective_at,
    'pauseCollectionBehavior', subscription_row.pause_collection_behavior,
    'currentPeriodEnd', subscription_row.current_period_end,
    'cancelAtPeriodEnd', subscription_row.cancel_at_period_end,
    'autoRenew', not subscription_row.cancel_at_period_end,
    'terminationIntent', subscription_row.termination_intent,
    'renewalActionRequested', subscription_row.renewal_action_requested,
    'renewalActionRequestedAt', subscription_row.renewal_action_requested_at,
    'cancellationReason', subscription_row.cancellation_reason,
    'canceledAt', subscription_row.canceled_at,
    'lastErrorCode', subscription_row.last_error_code,
    'updatedAt', subscription_row.updated_at
  );
end;
$$;

create or replace function public.request_my_subscription_renewal_action(
  target_workspace_id uuid,
  target_action text,
  target_reason text default null
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
  normalized_reason text := nullif(lower(trim(coalesce(target_reason,''))), '');
  subscription_row public.organization_subscriptions%rowtype;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;
  if normalized_action not in ('cancel','disable_auto_renew','reactivate') then
    raise exception 'subscription_renewal_action_not_allowed';
  end if;
  if normalized_reason is not null and char_length(normalized_reason) > 64 then
    raise exception 'subscription_cancellation_reason_too_long';
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
  if subscription_row.access_mode <> 'paid'
     or subscription_row.provider <> 'stripe'
     or subscription_row.provider_subscription_id is null then
    raise exception 'stripe_subscription_not_configured';
  end if;
  if subscription_row.status = 'canceled' and normalized_action <> 'reactivate' then
    raise exception 'subscription_already_canceled';
  end if;

  if normalized_action = 'reactivate'
     and not subscription_row.cancel_at_period_end
     and subscription_row.renewal_action_requested is null then
    return jsonb_build_object(
      'changed', false,
      'status', subscription_row.status,
      'subscriptionId', subscription_row.id,
      'providerSubscriptionId', subscription_row.provider_subscription_id,
      'cancelAtPeriodEnd', false
    );
  end if;

  if subscription_row.renewal_action_requested = normalized_action then
    return jsonb_build_object(
      'changed', false,
      'status', subscription_row.status,
      'subscriptionId', subscription_row.id,
      'providerSubscriptionId', subscription_row.provider_subscription_id,
      'cancelAtPeriodEnd', subscription_row.cancel_at_period_end
    );
  end if;

  update public.organization_subscriptions
  set renewal_action_requested = normalized_action,
      renewal_action_requested_at = now(),
      renewal_action_requested_by = actor_id,
      cancellation_reason = case when normalized_action = 'cancel' then normalized_reason else cancellation_reason end,
      last_error_code = null,
      updated_at = now()
  where id = subscription_row.id;

  insert into audit.audit_events(
    organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    org_id, actor_id, 'subscription.renewal_action.requested',
    'subscription', subscription_row.id::text, 'completed',
    jsonb_build_object(
      'action', normalized_action,
      'status', subscription_row.status,
      'cancelAtPeriodEnd', subscription_row.cancel_at_period_end,
      'reason', normalized_reason,
      'providerPending', true
    )
  );

  return jsonb_build_object(
    'changed', true,
    'status', subscription_row.status,
    'subscriptionId', subscription_row.id,
    'providerSubscriptionId', subscription_row.provider_subscription_id,
    'cancelAtPeriodEnd', subscription_row.cancel_at_period_end,
    'requestedAction', normalized_action
  );
end;
$$;

revoke all on function public.request_my_subscription_action(uuid,text) from public, anon;
grant execute on function public.request_my_subscription_action(uuid,text) to authenticated;

revoke all on function public.my_subscription_management_snapshot(uuid) from public, anon;
grant execute on function public.my_subscription_management_snapshot(uuid) to authenticated;

revoke all on function public.request_my_subscription_renewal_action(uuid,text,text) from public, anon;
grant execute on function public.request_my_subscription_renewal_action(uuid,text,text) to authenticated;

revoke all on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,timestamptz,text) to service_role;

commit;
