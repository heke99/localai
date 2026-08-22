do $$
declare
  missing_columns integer;
  org_admin_permissions integer;
  review_definition text;
begin
  select count(*) into missing_columns
  from (values
    ('invited_user_id'),
    ('invited_at'),
    ('password_email_sent_at'),
    ('onboarding_completed_at'),
    ('organization_id'),
    ('workspace_id')
  ) expected(column_name)
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'access_requests'
      and c.column_name = expected.column_name
  );
  if missing_columns <> 0 then raise exception 'missing onboarding access_request columns'; end if;

  if has_function_privilege('anon', 'public.complete_user_onboarding()', 'execute') then
    raise exception 'anon can complete onboarding';
  end if;
  if not has_function_privilege('authenticated', 'public.complete_user_onboarding()', 'execute') then
    raise exception 'authenticated cannot complete its own onboarding';
  end if;
  if has_function_privilege('anon', 'public.superadmin_provision_access_grant(uuid,uuid,text)', 'execute') then
    raise exception 'anon can provision access grants';
  end if;

  select count(*) into org_admin_permissions
  from public.roles r
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions p on p.id = rp.permission_id
  where r.organization_id is null
    and r.key = 'organization_admin'
    and p.key in ('agent.run', 'lab.run', 'project.read', 'project.write', 'integration.manage', 'audit.read');
  if org_admin_permissions <> 6 then raise exception 'organization_admin permissions incomplete: %', org_admin_permissions; end if;

  select pg_get_functiondef(p.oid) into review_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'superadmin_review_access_request';
  if review_definition not like '%use_grant_access_for_approval%' then
    raise exception 'direct approval bypass is still possible';
  end if;
end $$;
