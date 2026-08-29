do $$
declare missing text;
begin
  select string_agg(name, ', ') into missing
  from (values ('agent_kernel_checkpoints'),('agent_memory_records'),('agent_trajectories')) expected(name)
  where not exists(
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='internal' and c.relname=expected.name and c.relkind='r'
  );
  if missing is not null then raise exception 'missing Agent Kernel V2 learning tables: %', missing; end if;

  if exists(
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='internal'
      and c.relname in ('agent_kernel_checkpoints','agent_memory_records','agent_trajectories')
      and not c.relrowsecurity
  ) then raise exception 'all Agent Kernel V2 learning tables must have RLS enabled'; end if;

  if has_table_privilege('authenticated','internal.agent_kernel_checkpoints','SELECT')
    or has_table_privilege('authenticated','internal.agent_memory_records','SELECT')
    or has_table_privilege('authenticated','internal.agent_trajectories','SELECT')
    or has_table_privilege('anon','internal.agent_memory_records','SELECT') then
    raise exception 'Kernel learning tables must never be directly readable by client roles';
  end if;

  if not has_function_privilege('service_role','public.worker_record_agent_kernel_checkpoint(text,uuid,text,jsonb,text,jsonb,boolean)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_latest_verified_agent_kernel_checkpoint(uuid)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_upsert_agent_memory(text,uuid,text,text,text,jsonb,boolean,numeric)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_find_agent_memories(text,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.worker_record_agent_trajectory(text,uuid,text,text,jsonb,text,integer,boolean)','EXECUTE') then
    raise exception 'Agent Kernel V2 worker RPC grants are incomplete';
  end if;

  if has_function_privilege('authenticated','public.worker_record_agent_kernel_checkpoint(text,uuid,text,jsonb,text,jsonb,boolean)','EXECUTE')
    or has_function_privilege('authenticated','public.worker_find_agent_memories(text,integer)','EXECUTE')
    or has_function_privilege('anon','public.worker_record_agent_trajectory(text,uuid,text,text,jsonb,text,integer,boolean)','EXECUTE') then
    raise exception 'Agent Kernel V2 worker RPCs must not be callable by client roles';
  end if;

  if not exists(
    select 1 from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid=con.conrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='internal' and c.relname='agent_memory_records' and pg_get_constraintdef(con.oid) like '%verified_experience%'
  ) then raise exception 'verified experience evidence constraint missing'; end if;
end $$;
