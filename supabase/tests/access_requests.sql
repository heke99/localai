do $$
declare
  first_id uuid;
  duplicate_id uuid;
begin
  if not has_function_privilege('anon', 'public.submit_access_request(text,text,text,text)', 'execute') then
    raise exception 'anon cannot submit access request';
  end if;
  if not has_function_privilege('authenticated', 'public.submit_access_request(text,text,text,text)', 'execute') then
    raise exception 'authenticated cannot submit access request';
  end if;

  first_id := public.submit_access_request(
    'Access Request Test',
    'access-request-test@div3rsa.example',
    'DIV3RSA QA',
    'Database invariant test for the public access request submission flow.'
  );
  duplicate_id := public.submit_access_request(
    'Access Request Test',
    'ACCESS-REQUEST-TEST@DIV3RSA.EXAMPLE',
    'DIV3RSA QA',
    'Database invariant test for the public access request submission flow.'
  );

  if first_id is null or duplicate_id is distinct from first_id then
    raise exception 'access request submission is not idempotent';
  end if;

  delete from public.access_requests where id = first_id;
end $$;
