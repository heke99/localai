do $$
declare
  exposed_without_rls integer;
  alias_count integer;
  v2_alias_count integer;
begin
  select count(*) into exposed_without_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if exposed_without_rls <> 0 then raise exception 'public tables without RLS: %', exposed_without_rls; end if;

  if has_table_privilege('anon', 'public.access_requests', 'insert') then
    raise exception 'anon can insert access requests directly';
  end if;
  if has_table_privilege('anon', 'public.access_requests', 'select') then
    raise exception 'anon can read access requests';
  end if;
  if has_schema_privilege('authenticated', 'internal', 'usage') then
    raise exception 'authenticated role can access internal schema';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'start_agent_run'
      and has_function_privilege('authenticated', p.oid, 'execute')
  ) then
    raise exception 'authenticated cannot start agent runs';
  end if;
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'start_agent_run'
      and has_function_privilege('anon', p.oid, 'execute')
  ) then
    raise exception 'anon can start agent runs';
  end if;

  if has_function_privilege('authenticated', 'public.worker_claim_agent_run(text)', 'execute') then
    raise exception 'authenticated can claim worker jobs';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'internal.job_queue'::regclass) then
    raise exception 'internal.job_queue does not have RLS';
  end if;

  select count(*) into alias_count
  from internal.model_aliases a
  join internal.model_versions mv on mv.id = a.model_version_id
  join internal.model_artifacts ma on ma.model_version_id = mv.id
  where mv.version_key = 'v3-q8-0'
    and mv.revision = '768dd4ca58e1af3593605d93abef2c1c45647a07'
    and mv.status = 'verified'
    and mv.metadata->>'runtime_model' = 'localai-qwen38-v3-q8'
    and ma.filename = 'Qwen3.8-27B-OBLITERATED-Q8_0.gguf'
    and ma.quantization = 'Q8_0'
    and ma.sha256 = 'afa839b2fa5bc890e5735031dda2c6239d3b6bba3b6ffa29477cbc14a2e1f221'
    and ma.bytes = 29047075872;
  if alias_count <> 6 then raise exception 'expected 6 verified V3 Q8 aliases, got %', alias_count; end if;

  select count(*) into v2_alias_count
  from internal.model_aliases a
  join internal.model_versions mv on mv.id = a.model_version_id
  where mv.version_key = 'v2-q8-0';
  if v2_alias_count <> 0 then raise exception 'expected V2 to remain historical without production aliases, got %', v2_alias_count; end if;
end $$;
