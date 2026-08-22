begin;

alter table public.access_requests
  add column if not exists invited_user_id uuid references auth.users(id) on delete set null,
  add column if not exists invited_at timestamptz,
  add column if not exists password_email_sent_at timestamptz,
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists organization_id uuid references public.organizations(id) on delete set null,
  add column if not exists workspace_id uuid references public.workspaces(id) on delete set null;

create unique index if not exists access_requests_invited_user_idx
  on public.access_requests (invited_user_id)
  where invited_user_id is not null;

create index if not exists access_requests_onboarding_idx
  on public.access_requests (status, invited_user_id, onboarding_completed_at)
  where status = 'approved';

create or replace function public.superadmin_review_access_request(target_id uuid, decision public.access_request_status)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not internal.is_superadmin_aal2() then
    raise exception 'superadmin_aal2_required' using errcode = '42501';
  end if;
  if decision not in ('reviewing', 'rejected') then
    raise exception 'use_grant_access_for_approval';
  end if;

  update public.access_requests
  set status = decision,
      reviewed_by = (select auth.uid()),
      reviewed_at = now()
  where id = target_id
    and status in ('pending', 'reviewing');

  if not found then
    return false;
  end if;

  insert into audit.audit_events(actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted)
  values ((select auth.uid()), 'access_request.reviewed', 'access_request', target_id::text, 'completed', jsonb_build_object('decision', decision));

  return true;
end;
$$;

create or replace function public.superadmin_provision_access_grant(target_id uuid, target_user_id uuid, target_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  request_row public.access_requests%rowtype;
  resolved_org_id uuid;
  resolved_workspace_id uuid;
  target_email text;
  resolved_org_name text;
begin
  if not internal.is_superadmin_aal2() then
    raise exception 'superadmin_aal2_required' using errcode = '42501';
  end if;

  select * into request_row
  from public.access_requests
  where id = target_id
  for update;

  if not found then
    raise exception 'access_request_not_found';
  end if;
  if request_row.status = 'rejected' then
    raise exception 'access_request_rejected';
  end if;
  if request_row.invited_user_id is not null and request_row.invited_user_id <> target_user_id then
    raise exception 'access_request_user_mismatch';
  end if;

  select lower(u.email) into target_email
  from auth.users u
  where u.id = target_user_id;

  if target_email is null or target_email <> lower(request_row.email) then
    raise exception 'invited_user_email_mismatch';
  end if;
  if target_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
    raise exception 'invalid_organization_slug';
  end if;

  resolved_org_name := coalesce(nullif(trim(request_row.organization_name), ''), request_row.name);

  if request_row.organization_id is null then
    insert into public.organizations(slug, name, created_by)
    values (target_slug, resolved_org_name, actor_id)
    returning id into resolved_org_id;
  else
    resolved_org_id := request_row.organization_id;
  end if;

  if request_row.workspace_id is null then
    insert into public.workspaces(organization_id, name, created_by)
    values (resolved_org_id, 'Main workspace', actor_id)
    returning id into resolved_workspace_id;
  else
    resolved_workspace_id := request_row.workspace_id;
  end if;

  insert into public.profiles(user_id, display_name)
  values (target_user_id, request_row.name)
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  insert into public.organization_members(organization_id, user_id, status)
  values (resolved_org_id, target_user_id, 'invited')
  on conflict (organization_id, user_id) do nothing;

  update public.access_requests
  set status = 'approved',
      invited_user_id = target_user_id,
      invited_at = coalesce(invited_at, now()),
      organization_id = resolved_org_id,
      workspace_id = resolved_workspace_id,
      reviewed_by = actor_id,
      reviewed_at = now()
  where id = target_id;

  insert into audit.audit_events(organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted)
  values (resolved_org_id, actor_id, 'access_request.granted', 'access_request', target_id::text, 'completed', jsonb_build_object('invited_user_id', target_user_id));

  return jsonb_build_object(
    'organization_id', resolved_org_id,
    'workspace_id', resolved_workspace_id,
    'invited_user_id', target_user_id
  );
end;
$$;

create or replace function public.complete_user_onboarding()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  request_row public.access_requests%rowtype;
  confirmed_at timestamptz;
  password_hash text;
  admin_role_id uuid;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select u.email_confirmed_at, u.encrypted_password
  into confirmed_at, password_hash
  from auth.users u
  where u.id = actor_id;

  if confirmed_at is null then
    raise exception 'email_confirmation_required' using errcode = '42501';
  end if;
  if coalesce(password_hash, '') = '' then
    raise exception 'password_required' using errcode = '42501';
  end if;

  select * into request_row
  from public.access_requests
  where invited_user_id = actor_id
    and status = 'approved'
  order by reviewed_at desc nulls last, created_at desc
  limit 1
  for update;

  if not found or request_row.organization_id is null or request_row.workspace_id is null then
    raise exception 'approved_access_grant_required' using errcode = '42501';
  end if;

  if request_row.onboarding_completed_at is not null then
    return request_row.workspace_id;
  end if;

  update public.organization_members
  set status = 'active',
      joined_at = coalesce(joined_at, now())
  where organization_id = request_row.organization_id
    and user_id = actor_id;

  if not found then
    raise exception 'organization_membership_missing';
  end if;

  select r.id into admin_role_id
  from public.roles r
  where r.organization_id is null
    and r.key = 'organization_admin'
  limit 1;

  if admin_role_id is null then
    raise exception 'organization_admin_role_missing';
  end if;

  insert into public.user_roles(organization_id, user_id, role_id, granted_by)
  values (request_row.organization_id, actor_id, admin_role_id, request_row.reviewed_by)
  on conflict (organization_id, user_id, role_id) do nothing;

  insert into public.workspace_members(workspace_id, user_id, access_level)
  values (request_row.workspace_id, actor_id, 'admin')
  on conflict (workspace_id, user_id) do update
    set access_level = excluded.access_level;

  update public.access_requests
  set onboarding_completed_at = now()
  where id = request_row.id;

  insert into audit.audit_events(organization_id, actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted)
  values (request_row.organization_id, actor_id, 'user.onboarding.completed', 'user', actor_id::text, 'completed', jsonb_build_object('access_request_id', request_row.id, 'workspace_id', request_row.workspace_id));

  return request_row.workspace_id;
end;
$$;

revoke all on function public.superadmin_provision_access_grant(uuid, uuid, text) from public, anon;
revoke all on function public.complete_user_onboarding() from public, anon;
grant execute on function public.superadmin_provision_access_grant(uuid, uuid, text) to authenticated;
grant execute on function public.complete_user_onboarding() to authenticated;

insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on
  (r.key = 'member' and p.key in ('agent.run', 'project.read'))
  or (r.key = 'organization_admin' and p.key in ('agent.run', 'lab.run', 'project.read', 'project.write', 'integration.manage', 'audit.read'))
  or (r.key = 'superadmin')
where r.organization_id is null
on conflict do nothing;

commit;
