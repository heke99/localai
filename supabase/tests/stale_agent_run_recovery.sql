do $$
declare
  reap_body text;
  claim_body text;
  step_body text;
  stream_body text;
begin
  select p.prosrc into reap_body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='worker_reap_stale_agent_runs';
  if reap_body is null then raise exception 'missing worker_reap_stale_agent_runs'; end if;
  if reap_body not ilike '%leased_until < now()%' then raise exception 'reaper must require expired lease'; end if;
  if reap_body not ilike '%stale_worker_lease_expired%' then raise exception 'reaper must persist explicit failure code'; end if;
  if reap_body not ilike '%3 minutes%' or reap_body not ilike '%20 minutes%' then raise exception 'reaper must use mode-aware stale windows'; end if;

  select p.prosrc into claim_body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='worker_claim_agent_run';
  if claim_body not ilike '%worker_reap_stale_agent_runs%' then raise exception 'claim must reap stale blockers before selecting work'; end if;

  select p.prosrc into step_body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='worker_record_agent_step';
  if step_body not ilike '%leased_until%' or step_body not ilike '%2 minutes%' then raise exception 'agent steps must renew running lease'; end if;

  select p.prosrc into stream_body
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='worker_append_agent_run_stream';
  if stream_body not ilike '%leased_until%' or stream_body not ilike '%2 minutes%' then raise exception 'stream writes must renew running lease'; end if;

  if has_function_privilege('anon', 'public.worker_reap_stale_agent_runs()', 'EXECUTE') then
    raise exception 'anon must not execute stale-run reaper';
  end if;
  if has_function_privilege('authenticated', 'public.worker_reap_stale_agent_runs()', 'EXECUTE') then
    raise exception 'authenticated must not execute stale-run reaper';
  end if;
  if not has_function_privilege('service_role', 'public.worker_reap_stale_agent_runs()', 'EXECUTE') then
    raise exception 'service_role must execute stale-run reaper';
  end if;
end $$;
