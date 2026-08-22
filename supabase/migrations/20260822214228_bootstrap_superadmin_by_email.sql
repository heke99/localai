begin;

create or replace function public.bootstrap_initial_superadmin_from_email(
  provided_token_hash text,
  target_email text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
begin
  select u.id into target_user_id
  from auth.users u
  where lower(u.email) = lower(target_email)
  order by u.created_at asc
  limit 1;

  if target_user_id is null then
    raise exception 'bootstrap_user_not_found' using errcode = '42501';
  end if;

  return public.bootstrap_initial_superadmin(provided_token_hash, target_user_id, target_email);
end;
$$;

revoke all on function public.bootstrap_initial_superadmin_from_email(text,text) from public;
grant execute on function public.bootstrap_initial_superadmin_from_email(text,text) to anon, authenticated, service_role;

commit;
