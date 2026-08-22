begin;

create or replace function internal.is_superadmin_aal2() returns boolean
language sql stable security invoker set search_path = ''
as $$
  select internal.is_superadmin()
    and coalesce((auth.jwt() ->> 'aal') = 'aal2', false)
$$;
revoke all on function internal.is_superadmin_aal2() from public;
grant execute on function internal.is_superadmin_aal2() to authenticated, service_role;

drop policy access_requests_superadmin_select on public.access_requests;
create policy access_requests_superadmin_select on public.access_requests
for select to authenticated using ((select internal.is_superadmin_aal2()));

drop policy access_requests_superadmin_update on public.access_requests;
create policy access_requests_superadmin_update on public.access_requests
for update to authenticated
using ((select internal.is_superadmin_aal2()))
with check ((select internal.is_superadmin_aal2()));

revoke all on all tables in schema public from anon, authenticated;
grant insert on public.access_requests to anon;
grant select, update on public.access_requests to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.organizations, public.organization_members, public.roles, public.permissions,
  public.role_permissions, public.user_roles, public.workspaces, public.workspace_members,
  public.projects, public.project_repositories, public.conversations, public.messages to authenticated;

commit;
