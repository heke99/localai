begin;

create or replace function public.submit_access_request(
  target_name text,
  target_email text,
  target_organization_name text,
  target_use_case text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text := trim(coalesce(target_name, ''));
  normalized_email text := lower(trim(coalesce(target_email, '')));
  normalized_organization text := nullif(trim(coalesce(target_organization_name, '')), '');
  normalized_use_case text := trim(coalesce(target_use_case, ''));
  request_id uuid;
begin
  if char_length(normalized_name) not between 2 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if char_length(normalized_email) not between 3 and 320
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if normalized_organization is not null and char_length(normalized_organization) > 160 then
    raise exception 'invalid_organization' using errcode = '22023';
  end if;
  if char_length(normalized_use_case) not between 20 and 3000 then
    raise exception 'invalid_use_case' using errcode = '22023';
  end if;

  select ar.id into request_id
  from public.access_requests ar
  where lower(ar.email) = normalized_email
    and ar.status in ('pending', 'reviewing')
  order by ar.created_at desc
  limit 1;

  if request_id is not null then
    return request_id;
  end if;

  begin
    insert into public.access_requests(name, email, organization_name, use_case)
    values (normalized_name, normalized_email, normalized_organization, normalized_use_case)
    returning id into request_id;
  exception when unique_violation then
    select ar.id into request_id
    from public.access_requests ar
    where lower(ar.email) = normalized_email
      and ar.status in ('pending', 'reviewing')
    order by ar.created_at desc
    limit 1;
  end;

  if request_id is null then
    raise exception 'access_request_insert_failed';
  end if;

  return request_id;
end;
$$;

revoke all on function public.submit_access_request(text, text, text, text) from public;
grant execute on function public.submit_access_request(text, text, text, text) to anon, authenticated;

commit;
