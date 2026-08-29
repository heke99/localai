do $$
declare
  body text;
begin
  if not has_function_privilege('service_role','public.worker_export_verified_agent_learning(integer,integer,timestamptz)','EXECUTE') then
    raise exception 'service_role must be able to export verified Agent Kernel learning data';
  end if;

  if has_function_privilege('authenticated','public.worker_export_verified_agent_learning(integer,integer,timestamptz)','EXECUTE')
    or has_function_privilege('anon','public.worker_export_verified_agent_learning(integer,integer,timestamptz)','EXECUTE') then
    raise exception 'client roles must not be able to export Agent Kernel learning data';
  end if;

  select p.prosrc into body
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='worker_export_verified_agent_learning';

  if body is null then raise exception 'verified learning export RPC missing'; end if;
  if position('t.training_eligible' in body)=0 then raise exception 'learning export must require training_eligible trajectories'; end if;
  if position('verificationResult' in body)=0 or position('failed' in body)=0 or position('passed' in body)=0 then
    raise exception 'learning export must independently enforce verification outcome';
  end if;
  if position('target_created_before' in body)=0 then raise exception 'learning export must use an explicit immutable cutoff'; end if;
  if position('trajectoryId' in body)=0 or position('modelVersion' in body)=0 or position('promptVersion' in body)=0 then
    raise exception 'learning export structural fields missing';
  end if;
  if position('prompt_text' in lower(body))>0 or position('raw_prompt' in lower(body))>0 or position('reasoning_text' in lower(body))>0 then
    raise exception 'learning export must not expose raw prompts or hidden reasoning';
  end if;
end $$;
