do $$
declare missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('agent_run_intelligence'),('repository_indexes'),('repository_index_nodes'),('repository_index_edges'),
    ('impact_analyses'),('impact_nodes'),('verification_runs'),('verification_results'),('run_skill_observations')
  ) expected(name)
  where not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='internal' and c.relname=expected.name and c.relkind='r');
  if missing is not null then raise exception 'missing observability tables: %', missing; end if;

  if exists(
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='internal' and c.relname in ('agent_run_intelligence','repository_indexes','repository_index_nodes','repository_index_edges','impact_analyses','impact_nodes','verification_runs','verification_results','run_skill_observations') and not c.relrowsecurity
  ) then raise exception 'all observability tables must have RLS enabled'; end if;

  if has_table_privilege('authenticated','internal.repository_indexes','SELECT') or has_table_privilege('anon','internal.repository_indexes','SELECT') then
    raise exception 'repository index tables must not be directly readable by client roles';
  end if;

  if not has_function_privilege('service_role','public.worker_record_run_intelligence(uuid,jsonb,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_begin_repository_index(uuid,uuid,text,integer,text,text,text,text,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_append_repository_index(uuid,jsonb,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_finish_repository_index(uuid,boolean,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_record_impact_analysis(uuid,integer,uuid,text,jsonb,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_record_verification_run(uuid,integer,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE') then
    raise exception 'worker observability RPC grants are incomplete';
  end if;

  if has_function_privilege('authenticated','public.worker_record_run_intelligence(uuid,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.worker_record_verification_run(uuid,integer,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','EXECUTE') then
    raise exception 'worker observability RPCs must not be callable by client roles';
  end if;

  if not has_function_privilege('authenticated','public.superadmin_agent_platform_snapshot()','EXECUTE')
    or not has_function_privilege('authenticated','public.superadmin_agent_run_trace(uuid)','EXECUTE') then
    raise exception 'superadmin observability RPCs must be callable by authenticated users and enforce step-up internally';
  end if;
end $$;
