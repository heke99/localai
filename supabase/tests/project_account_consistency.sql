do $$
declare
  immutable_trigger_count integer;
  subscription_policy_count integer;
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.conversations'::regclass
      and conname = 'conversations_project_workspace_fk'
      and contype = 'f'
  ) then
    raise exception 'conversation project/workspace composite FK missing';
  end if;

  select count(*) into immutable_trigger_count
  from pg_trigger
  where not tgisinternal
    and tgrelid in ('public.projects'::regclass, 'public.conversations'::regclass, 'public.messages'::regclass)
    and tgname in ('projects_identity_immutable','conversations_identity_immutable','messages_identity_immutable');
  if immutable_trigger_count <> 3 then
    raise exception 'expected 3 immutable identity triggers, got %', immutable_trigger_count;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='account_status'
  ) then
    raise exception 'profiles.account_status missing';
  end if;

  if has_column_privilege('authenticated', 'public.profiles', 'account_status', 'update') then
    raise exception 'authenticated can mutate account_status directly';
  end if;
  if not has_column_privilege('authenticated', 'public.profiles', 'display_name', 'update') then
    raise exception 'authenticated cannot update display_name';
  end if;
  if not has_function_privilege('authenticated', 'public.set_my_account_status(text)', 'execute') then
    raise exception 'authenticated cannot use self account lifecycle RPC';
  end if;
  if has_function_privilege('anon', 'public.set_my_account_status(text)', 'execute') then
    raise exception 'anon can use self account lifecycle RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.superadmin_set_account_status(uuid,text)', 'execute') then
    raise exception 'authenticated superadmin sessions cannot invoke guarded lifecycle RPC';
  end if;
  if has_function_privilege('anon', 'public.superadmin_set_account_status(uuid,text)', 'execute') then
    raise exception 'anon can invoke superadmin lifecycle RPC';
  end if;

  if to_regclass('public.organization_subscriptions') is null then
    raise exception 'organization_subscriptions missing';
  end if;
  if has_table_privilege('authenticated', 'public.organization_subscriptions', 'insert')
     or has_table_privilege('authenticated', 'public.organization_subscriptions', 'update')
     or has_table_privilege('authenticated', 'public.organization_subscriptions', 'delete') then
    raise exception 'authenticated can mutate subscriptions directly';
  end if;
  if not has_table_privilege('authenticated', 'public.organization_subscriptions', 'select') then
    raise exception 'authenticated cannot read subscription state';
  end if;

  select count(*) into subscription_policy_count
  from pg_policies
  where schemaname='public'
    and tablename='organization_subscriptions'
    and policyname='organization_subscriptions_member_select';
  if subscription_policy_count <> 1 then
    raise exception 'subscription member select policy missing';
  end if;

  if not has_function_privilege('authenticated', 'public.my_subscription_snapshot(uuid)', 'execute') then
    raise exception 'authenticated cannot read subscription snapshot';
  end if;
  if not has_function_privilege('authenticated', 'public.request_my_subscription_action(uuid,text)', 'execute') then
    raise exception 'authenticated cannot request subscription lifecycle action';
  end if;
  if has_function_privilege('authenticated', 'public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,timestamptz,text)', 'execute') then
    raise exception 'authenticated can forge provider subscription confirmation';
  end if;
  if not has_function_privilege('service_role', 'public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,timestamptz,text)', 'execute') then
    raise exception 'service role cannot confirm provider subscription status';
  end if;

  if has_function_privilege('anon', 'internal.is_org_member(uuid)', 'execute')
     or has_function_privilege('anon', 'internal.is_workspace_member(uuid)', 'execute') then
    raise exception 'anon can execute membership policy helpers';
  end if;
end $$;
