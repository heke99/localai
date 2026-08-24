do $$
begin
  if not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='internal' and c.relname='agent_platform_exports' and c.relrowsecurity) then
    raise exception 'agent_platform_exports must exist with RLS';
  end if;
  if not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='internal' and c.relname='agent_platform_imports' and c.relrowsecurity) then
    raise exception 'agent_platform_imports must exist with RLS';
  end if;
  if has_table_privilege('authenticated','internal.agent_platform_exports','SELECT') or has_table_privilege('anon','internal.agent_platform_imports','SELECT') then
    raise exception 'portability tables must not be directly client-readable';
  end if;
  if not has_function_privilege('authenticated','public.superadmin_portability_source()','EXECUTE')
     or not has_function_privilege('authenticated','public.superadmin_record_platform_export(text,jsonb,jsonb,uuid[],uuid[])','EXECUTE')
     or not has_function_privilege('authenticated','public.superadmin_record_platform_import(text,jsonb,jsonb,uuid[],uuid[],jsonb,jsonb)','EXECUTE')
     or not has_function_privilege('authenticated','public.superadmin_activate_platform_import(uuid)','EXECUTE')
     or not has_function_privilege('authenticated','public.superadmin_platform_import_status(uuid)','EXECUTE') then
    raise exception 'superadmin portability RPC grants incomplete';
  end if;
  if has_function_privilege('anon','public.superadmin_activate_platform_import(uuid)','EXECUTE') then
    raise exception 'anon must never activate portability imports';
  end if;
end $$;
