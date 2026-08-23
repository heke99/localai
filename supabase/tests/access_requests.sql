do $$
declare
  anon_insert_policy_count integer;
begin
  if has_table_privilege('anon', 'public.access_requests', 'insert') then
    raise exception 'anon can insert access requests directly';
  end if;
  if has_table_privilege('authenticated', 'public.access_requests', 'insert') then
    raise exception 'authenticated can insert access requests directly';
  end if;

  select count(*) into anon_insert_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'access_requests'
    and policyname = 'access_requests_anon_insert';
  if anon_insert_policy_count <> 0 then
    raise exception 'legacy anonymous access request insert policy still exists';
  end if;

  if to_regprocedure('public.submit_access_request(text,text,text,text)') is not null then
    raise exception 'public access request definer RPC should not exist';
  end if;
end $$;
