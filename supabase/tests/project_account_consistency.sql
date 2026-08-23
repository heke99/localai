do $$
declare
  immutable_trigger_count integer;
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
    raise exception 'authenticated cannot use account lifecycle RPC';
  end if;
  if has_function_privilege('anon', 'public.set_my_account_status(text)', 'execute') then
    raise exception 'anon can use account lifecycle RPC';
  end if;
end $$;
