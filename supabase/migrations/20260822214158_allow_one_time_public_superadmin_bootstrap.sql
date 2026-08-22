begin;

create or replace function public.bootstrap_initial_superadmin(
  provided_token_hash text,
  target_user_id uuid,
  target_email text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  bootstrap_row internal.bootstrap_tokens%rowtype;
  verified_email text;
  internal_org_id uuid;
  internal_workspace_id uuid;
  superadmin_role_id uuid;
begin
  select * into bootstrap_row
  from internal.bootstrap_tokens
  where purpose = 'initial_superadmin'
  for update;

  if not found
     or bootstrap_row.consumed_at is not null
     or bootstrap_row.expires_at <= now()
     or bootstrap_row.token_hash <> provided_token_hash
     or lower(bootstrap_row.email) <> lower(target_email) then
    raise exception 'invalid_or_expired_bootstrap_token' using errcode = '42501';
  end if;

  select lower(email) into verified_email
  from auth.users
  where id = target_user_id;

  if verified_email is null or verified_email <> lower(target_email) then
    raise exception 'bootstrap_user_email_mismatch' using errcode = '42501';
  end if;

  if exists (
    select 1 from auth.users u
    where u.id <> target_user_id
      and coalesce(u.raw_app_meta_data ->> 'system_role', '') = 'superadmin'
  ) then
    raise exception 'superadmin_already_exists' using errcode = '42501';
  end if;

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('system_role', 'superadmin'),
      updated_at = now()
  where id = target_user_id;

  insert into public.organizations(slug, name, created_by)
  values ('div3rsa-internal', 'DIV3RSA Internal', target_user_id)
  on conflict (slug) do update set name = excluded.name
  returning id into internal_org_id;

  select id into internal_workspace_id
  from public.workspaces
  where organization_id = internal_org_id and name = 'Internal workspace'
  order by created_at asc
  limit 1;

  if internal_workspace_id is null then
    insert into public.workspaces(organization_id, name, created_by)
    values (internal_org_id, 'Internal workspace', target_user_id)
    returning id into internal_workspace_id;
  end if;

  insert into public.profiles(user_id, display_name)
  values (target_user_id, 'Hekmat')
  on conflict (user_id) do update
  set display_name = excluded.display_name,
      updated_at = now();

  insert into public.organization_members(organization_id, user_id, status, joined_at)
  values (internal_org_id, target_user_id, 'active', now())
  on conflict (organization_id, user_id) do update
  set status = 'active',
      joined_at = coalesce(public.organization_members.joined_at, excluded.joined_at);

  select id into superadmin_role_id
  from public.roles
  where organization_id is null and key = 'superadmin'
  limit 1;

  if superadmin_role_id is null then
    raise exception 'superadmin_role_missing';
  end if;

  insert into public.user_roles(organization_id, user_id, role_id, granted_by)
  values (internal_org_id, target_user_id, superadmin_role_id, target_user_id)
  on conflict (organization_id, user_id, role_id) do nothing;

  insert into public.workspace_members(workspace_id, user_id, access_level)
  values (internal_workspace_id, target_user_id, 'admin')
  on conflict (workspace_id, user_id) do update
  set access_level = excluded.access_level;

  update internal.bootstrap_tokens
  set consumed_at = now()
  where id = bootstrap_row.id;

  insert into audit.audit_events(
    organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
  ) values (
    internal_org_id, target_user_id, 'system.superadmin.bootstrapped', 'user', target_user_id::text, 'completed',
    jsonb_build_object('workspace_id', internal_workspace_id)
  );

  return jsonb_build_object(
    'user_id', target_user_id,
    'organization_id', internal_org_id,
    'workspace_id', internal_workspace_id
  );
end;
$$;

revoke all on function public.bootstrap_initial_superadmin(text,uuid,text) from public;
grant execute on function public.bootstrap_initial_superadmin(text,uuid,text) to anon, authenticated, service_role;

commit;
