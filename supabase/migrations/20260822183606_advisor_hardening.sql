begin;

drop policy access_requests_superadmin_select on public.access_requests;
create policy access_requests_superadmin_select on public.access_requests
for select to authenticated
using ((select internal.is_superadmin()) and (select auth.jwt()->>'aal') = 'aal2');

drop policy access_requests_superadmin_update on public.access_requests;
create policy access_requests_superadmin_update on public.access_requests
for update to authenticated
using ((select internal.is_superadmin()) and (select auth.jwt()->>'aal') = 'aal2')
with check ((select internal.is_superadmin()) and (select auth.jwt()->>'aal') = 'aal2');

-- Cover the user-facing FK paths that participate in tenant reads and cascade checks.
create index project_repositories_project_idx on public.project_repositories(project_id);
create index conversations_project_idx on public.conversations(project_id) where project_id is not null;
create index messages_actor_idx on public.messages(actor_user_id) where actor_user_id is not null;
create index messages_model_version_idx on public.messages(model_version_id) where model_version_id is not null;
create index user_roles_user_idx on public.user_roles(user_id, organization_id);
create index user_roles_role_idx on public.user_roles(role_id);
create index role_permissions_permission_idx on public.role_permissions(permission_id);

commit;
