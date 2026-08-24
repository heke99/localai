do $$
declare
  missing_columns integer;
  action_definition text;
begin
  select count(*) into missing_columns
  from (values
    ('cancel_at_period_end'),
    ('termination_intent'),
    ('renewal_action_requested'),
    ('renewal_action_requested_at'),
    ('renewal_action_requested_by'),
    ('cancellation_reason'),
    ('canceled_at'),
    ('pause_collection_behavior')
  ) expected(column_name)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'organization_subscriptions'
      and c.column_name = expected.column_name
  );

  if missing_columns <> 0 then
    raise exception 'subscription self-service columns missing: %', missing_columns;
  end if;

  if to_regprocedure('public.my_subscription_management_snapshot(uuid)') is null then
    raise exception 'subscription management snapshot RPC missing';
  end if;
  if to_regprocedure('public.request_my_subscription_renewal_action(uuid,text,text)') is null then
    raise exception 'subscription renewal action RPC missing';
  end if;

  if not has_function_privilege('authenticated', 'public.my_subscription_management_snapshot(uuid)', 'execute') then
    raise exception 'authenticated cannot read subscription management snapshot';
  end if;
  if has_function_privilege('anon', 'public.my_subscription_management_snapshot(uuid)', 'execute') then
    raise exception 'anon can read subscription management snapshot';
  end if;
  if not has_function_privilege('authenticated', 'public.request_my_subscription_renewal_action(uuid,text,text)', 'execute') then
    raise exception 'authenticated cannot request subscription renewal actions';
  end if;
  if has_function_privilege('anon', 'public.request_my_subscription_renewal_action(uuid,text,text)', 'execute') then
    raise exception 'anon can request subscription renewal actions';
  end if;

  if has_table_privilege('authenticated', 'public.organization_subscriptions', 'update') then
    raise exception 'authenticated can mutate provider-confirmed subscription state directly';
  end if;

  select pg_get_functiondef('public.request_my_subscription_action(uuid,text)'::regprocedure)
  into action_definition;

  if position('set status =' in lower(action_definition)) > 0 then
    raise exception 'pause/resume request still mutates subscription status before provider confirmation';
  end if;
  if position('requested_action = normalized_action' in lower(action_definition)) = 0 then
    raise exception 'pause/resume request no longer records pending provider action';
  end if;
end $$;
