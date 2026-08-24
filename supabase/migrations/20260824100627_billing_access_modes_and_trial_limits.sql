begin;

alter table public.access_requests
  add column if not exists access_mode text,
  add column if not exists trial_days integer,
  add column if not exists trial_token_limit bigint,
  add column if not exists billing_checkout_session_id text,
  add column if not exists billing_checkout_url text,
  add column if not exists billing_configured_at timestamptz;

alter table public.access_requests drop constraint if exists access_requests_access_mode_check;
alter table public.access_requests add constraint access_requests_access_mode_check
  check (access_mode is null or access_mode in ('paid','free','trial'));
alter table public.access_requests drop constraint if exists access_requests_trial_days_check;
alter table public.access_requests add constraint access_requests_trial_days_check
  check (trial_days is null or trial_days between 1 and 90);
alter table public.access_requests drop constraint if exists access_requests_trial_token_limit_check;
alter table public.access_requests add constraint access_requests_trial_token_limit_check
  check (trial_token_limit is null or trial_token_limit between 1000 and 1000000000);

alter table public.organization_subscriptions
  add column if not exists access_mode text not null default 'paid',
  add column if not exists provider_customer_id text,
  add column if not exists checkout_session_id text,
  add column if not exists checkout_url text,
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists trial_token_limit bigint,
  add column if not exists access_granted_by uuid references auth.users(id) on delete set null,
  add column if not exists access_configured_at timestamptz;

alter table public.organization_subscriptions drop constraint if exists organization_subscriptions_access_mode_check;
alter table public.organization_subscriptions add constraint organization_subscriptions_access_mode_check
  check (access_mode in ('paid','free','trial'));
alter table public.organization_subscriptions drop constraint if exists organization_subscriptions_trial_window_check;
alter table public.organization_subscriptions add constraint organization_subscriptions_trial_window_check
  check (
    (access_mode <> 'trial' and trial_started_at is null and trial_ends_at is null and trial_token_limit is null)
    or (access_mode = 'trial' and trial_started_at is not null and trial_ends_at is not null and trial_ends_at > trial_started_at and trial_token_limit is not null and trial_token_limit > 0)
  );

create unique index if not exists organization_subscriptions_provider_customer_idx
  on public.organization_subscriptions(provider, provider_customer_id)
  where provider_customer_id is not null;

create or replace function internal.current_actor_trial_tokens_used(target_organization_id uuid, target_started_at timestamptz)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(coalesce(u.input_tokens,0) + coalesce(u.output_tokens,0)),0)::bigint
  from internal.usage_events u
  where u.organization_id = target_organization_id
    and u.user_id = (select auth.uid())
    and u.occurred_at >= target_started_at
$$;

create or replace function internal.current_actor_has_agent_access(target_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  row public.organization_subscriptions%rowtype;
  used_tokens bigint := 0;
begin
  if auth.uid() is null then return false; end if;
  if internal.is_superadmin() then return true; end if;

  select * into row
  from public.organization_subscriptions s
  where s.organization_id = target_organization_id;
  if row.id is null then return false; end if;

  if row.access_mode = 'free' then return row.status = 'active'; end if;
  if row.access_mode = 'paid' then return row.status in ('active','trialing'); end if;

  if row.access_mode = 'trial' then
    if row.status <> 'trialing' or row.trial_ends_at is null or row.trial_ends_at <= now() then return false; end if;
    used_tokens := internal.current_actor_trial_tokens_used(target_organization_id, row.trial_started_at);
    return used_tokens < row.trial_token_limit;
  end if;
  return false;
end;
$$;

create or replace function public.my_agent_access_snapshot(target_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  row public.organization_subscriptions%rowtype;
  used_tokens bigint := 0;
  allowed boolean := false;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id = target_workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode='42501'; end if;
  if internal.is_superadmin() then return jsonb_build_object('allowed', true, 'accessMode', 'superadmin', 'status', 'active', 'billingExempt', true); end if;

  select * into row from public.organization_subscriptions s where s.organization_id = org_id;
  if row.id is null then return jsonb_build_object('allowed', false, 'accessMode', 'paid', 'status', 'inactive', 'requiresPayment', true, 'priceSekMonthly', 2000); end if;
  if row.access_mode = 'trial' and row.trial_started_at is not null then used_tokens := internal.current_actor_trial_tokens_used(org_id, row.trial_started_at); end if;
  allowed := internal.current_actor_has_agent_access(org_id);

  return jsonb_build_object(
    'allowed', allowed,
    'accessMode', row.access_mode,
    'status', row.status,
    'provider', row.provider,
    'providerStatus', row.provider_status,
    'requiresPayment', row.access_mode = 'paid' and not allowed,
    'priceSekMonthly', 2000,
    'checkoutUrl', row.checkout_url,
    'trialStartedAt', row.trial_started_at,
    'trialEndsAt', row.trial_ends_at,
    'trialTokenLimit', row.trial_token_limit,
    'trialTokensUsed', used_tokens,
    'trialTokensRemaining', case when row.trial_token_limit is null then null else greatest(row.trial_token_limit - used_tokens, 0) end,
    'currentPeriodEnd', row.current_period_end,
    'providerCustomerId', row.provider_customer_id
  );
end;
$$;

create or replace function public.superadmin_configure_organization_access(
  target_organization_id uuid,
  target_access_mode text,
  target_trial_days integer default null,
  target_trial_token_limit bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  normalized_mode text := lower(trim(coalesce(target_access_mode,'')));
  existing public.organization_subscriptions%rowtype;
  result_row public.organization_subscriptions%rowtype;
  start_at timestamptz;
  end_at timestamptz;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if not internal.is_superadmin() then raise exception 'superadmin_required' using errcode='42501'; end if;
  if normalized_mode not in ('paid','free','trial') then raise exception 'access_mode_not_allowed'; end if;
  if not exists (select 1 from public.organizations o where o.id = target_organization_id) then raise exception 'organization_not_found'; end if;

  select * into existing from public.organization_subscriptions s where s.organization_id = target_organization_id for update;
  if normalized_mode in ('free','trial') and existing.provider_subscription_id is not null and existing.status <> 'canceled' then raise exception 'stripe_subscription_must_be_canceled_first'; end if;

  if normalized_mode = 'trial' then
    if target_trial_days is null or target_trial_days not between 1 and 90 then raise exception 'trial_days_invalid'; end if;
    if target_trial_token_limit is null or target_trial_token_limit < 1000 or target_trial_token_limit > 1000000000 then raise exception 'trial_token_limit_invalid'; end if;
    start_at := now();
    end_at := start_at + make_interval(days => target_trial_days);
  end if;

  insert into public.organization_subscriptions(
    organization_id, provider, access_mode, status, provider_status,
    provider_subscription_id, provider_customer_id, checkout_session_id, checkout_url,
    trial_started_at, trial_ends_at, trial_token_limit,
    access_granted_by, access_configured_at, updated_at
  ) values (
    target_organization_id,
    case when normalized_mode='paid' then 'stripe' else 'internal' end,
    normalized_mode,
    case when normalized_mode='paid' then 'inactive' when normalized_mode='free' then 'active' else 'trialing' end,
    case when normalized_mode='free' then 'free' when normalized_mode='trial' then 'trial' else null end,
    null, null, null, null,
    start_at, end_at, case when normalized_mode='trial' then target_trial_token_limit else null end,
    actor_id, now(), now()
  )
  on conflict (organization_id) do update set
    provider = excluded.provider,
    access_mode = excluded.access_mode,
    status = case when excluded.access_mode='paid' and public.organization_subscriptions.access_mode='paid' and public.organization_subscriptions.status in ('active','trialing','past_due') then public.organization_subscriptions.status else excluded.status end,
    provider_status = case when excluded.access_mode='paid' then public.organization_subscriptions.provider_status else excluded.provider_status end,
    provider_subscription_id = case when excluded.access_mode='paid' then public.organization_subscriptions.provider_subscription_id else null end,
    provider_customer_id = case when excluded.access_mode='paid' then public.organization_subscriptions.provider_customer_id else null end,
    checkout_session_id = case when excluded.access_mode='paid' then public.organization_subscriptions.checkout_session_id else null end,
    checkout_url = case when excluded.access_mode='paid' then public.organization_subscriptions.checkout_url else null end,
    trial_started_at = excluded.trial_started_at,
    trial_ends_at = excluded.trial_ends_at,
    trial_token_limit = excluded.trial_token_limit,
    access_granted_by = actor_id,
    access_configured_at = now(),
    last_error_code = null,
    updated_at = now()
  returning * into result_row;

  insert into audit.audit_events(organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted)
  values(target_organization_id, actor_id, 'billing.access.configured', 'organization', target_organization_id::text, 'completed', jsonb_build_object('accessMode', normalized_mode, 'trialDays', target_trial_days, 'trialTokenLimit', target_trial_token_limit));

  return jsonb_build_object('organizationId', target_organization_id, 'accessMode', result_row.access_mode, 'status', result_row.status, 'trialEndsAt', result_row.trial_ends_at, 'trialTokenLimit', result_row.trial_token_limit);
end;
$$;

create or replace function public.start_agent_run(workspace_id uuid, conversation_id uuid, mode text, prompt text, request_id text, trace_id text, resource_ids uuid[] default null::uuid[])
returns table(run_id uuid, resolved_conversation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  target_conversation_id uuid := conversation_id;
  target_project_id uuid;
  conversation_mode text;
  selected_alias text;
  new_run_id uuid;
  resources jsonb;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if mode not in ('chat','code','lab','research') then raise exception 'invalid_mode'; end if;
  if char_length(trim(prompt))<1 or char_length(prompt)>100000 then raise exception 'invalid_prompt'; end if;

  select w.organization_id into org_id from public.workspaces w where w.id=workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied'; end if;
  if not internal.has_permission(org_id,case when mode='lab' then 'lab.run' else 'agent.run' end) then raise exception 'permission_denied'; end if;
  if not internal.current_actor_has_agent_access(org_id) then raise exception 'subscription_access_required' using errcode='42501'; end if;

  if target_conversation_id is null then
    target_project_id := internal.ensure_standalone_project(workspace_id, actor_id);
    insert into public.conversations(workspace_id,project_id,created_by,mode,title) values(workspace_id,target_project_id,actor_id,mode,left(trim(prompt),100)) returning id,public.conversations.mode into target_conversation_id,conversation_mode;
  else
    select c.project_id,c.mode into target_project_id,conversation_mode from public.conversations c where c.id=target_conversation_id and c.workspace_id=start_agent_run.workspace_id;
    if not found then raise exception 'conversation_access_denied'; end if;
    if conversation_mode<>mode then raise exception 'conversation_mode_mismatch'; end if;
    if target_project_id is null then target_project_id := internal.ensure_standalone_project(workspace_id, actor_id); update public.conversations set project_id=target_project_id where id=target_conversation_id; end if;
    update public.conversations c set title=case when c.title is null or c.title='Ny chatt' then left(trim(prompt),100) else c.title end,updated_at=now() where c.id=target_conversation_id;
  end if;

  if resource_ids is not null then perform public.set_conversation_resources(target_conversation_id,resource_ids); end if;
  insert into public.messages(conversation_id,actor_user_id,role,content) values(target_conversation_id,actor_id,'user',jsonb_build_object('text',prompt));
  resources:=internal.resource_context_for_conversation(target_conversation_id);
  selected_alias:=case mode when 'code' then 'code-prod' when 'lab' then 'lab-prod' when 'research' then 'research-prod' else 'general-prod' end;
  insert into internal.agent_runs(conversation_id,organization_id,requested_by,status,request_id,trace_id,model_alias,mode,resource_context) values(target_conversation_id,org_id,actor_id,'queued',request_id,trace_id,selected_alias,mode,resources) returning id into new_run_id;
  insert into audit.audit_events(organization_id,actor_user_id,request_id,trace_id,event_type,target_type,target_id,outcome,metadata_redacted) values(org_id,actor_id,request_id,trace_id,'agent.run.requested','agent_run',new_run_id::text,'accepted',jsonb_build_object('mode',mode,'project_id',target_project_id,'resource_count',jsonb_array_length(resources)));
  return query select new_run_id,target_conversation_id;
end;
$$;

revoke all on function internal.current_actor_trial_tokens_used(uuid,timestamptz) from public, anon;
revoke all on function internal.current_actor_has_agent_access(uuid) from public, anon;
grant execute on function internal.current_actor_trial_tokens_used(uuid,timestamptz) to authenticated, service_role;
grant execute on function internal.current_actor_has_agent_access(uuid) to authenticated, service_role;
revoke all on function public.my_agent_access_snapshot(uuid) from public, anon;
grant execute on function public.my_agent_access_snapshot(uuid) to authenticated;
revoke all on function public.superadmin_configure_organization_access(uuid,text,integer,bigint) from public, anon;
grant execute on function public.superadmin_configure_organization_access(uuid,text,integer,bigint) to authenticated;

commit;
