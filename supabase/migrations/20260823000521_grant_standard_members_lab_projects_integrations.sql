insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'member'
  and p.key in ('lab.run','project.write','integration.manage')
on conflict do nothing;
