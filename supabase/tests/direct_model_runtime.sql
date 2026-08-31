do $$
declare
  active_index_unique boolean;
  active_index_predicate text;
  prepare_definition text;
  preflight_definition text;
  complete_definition text;
  exclusivity_definition text;
  agent_trigger_count integer;
  direct_trigger_count integer;
begin
  if to_regclass('internal.direct_model_runs') is null then
    raise exception 'direct_model_runs table is missing';
  end if;

  select i.indisunique, pg_get_expr(i.indpred, i.indrelid)
  into active_index_unique, active_index_predicate
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'internal'
    and c.relname = 'direct_model_runs_one_active_per_conversation_idx';

  if not coalesce(active_index_unique, false) or position('running' in coalesce(active_index_predicate,'')) = 0 then
    raise exception 'direct model active-run uniqueness is missing: %', active_index_predicate;
  end if;

  select pg_get_functiondef('public.prepare_direct_model_run(uuid,uuid,text,text,text,text)'::regprocedure)
  into prepare_definition;
  if position('internal.has_permission' in prepare_definition) = 0
     or position('internal.current_actor_has_agent_access' in prepare_definition) = 0
     or position('public.messages' in prepare_definition) = 0
     or position('audit.audit_events' in prepare_definition) = 0 then
    raise exception 'direct model prepare contract is missing authorization or audit controls';
  end if;

  select pg_get_functiondef('public.direct_model_access_preflight(uuid,uuid,text)'::regprocedure)
  into preflight_definition;
  if position('internal.has_permission' in preflight_definition) = 0
     or position('internal.current_actor_has_agent_access' in preflight_definition) = 0
     or position('insert into' in lower(preflight_definition)) > 0 then
    raise exception 'direct model preflight is not side-effect-free or access-complete';
  end if;

  select pg_get_functiondef('public.complete_direct_model_run(uuid,text,bigint,bigint)'::regprocedure)
  into complete_definition;
  if position('internal.usage_events' in complete_definition) = 0
     or position('public.messages' in complete_definition) = 0
     or position('model.direct.completed' in complete_definition) = 0 then
    raise exception 'direct completion does not persist response, usage, and audit evidence';
  end if;

  select pg_get_functiondef('internal.enforce_conversation_execution_exclusivity()'::regprocedure)
  into exclusivity_definition;
  if position('pg_advisory_xact_lock' in exclusivity_definition) = 0
     or position('internal.agent_runs' in exclusivity_definition) = 0
     or position('internal.direct_model_runs' in exclusivity_definition) = 0
     or position('conversation_has_active_run' in exclusivity_definition) = 0 then
    raise exception 'agent/direct execution paths are not serialized by the same database lock';
  end if;

  select count(*) into agent_trigger_count
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'internal'
    and c.relname = 'agent_runs'
    and t.tgname = 'agent_runs_conversation_execution_exclusivity'
    and not t.tgisinternal;

  select count(*) into direct_trigger_count
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'internal'
    and c.relname = 'direct_model_runs'
    and t.tgname = 'direct_model_runs_conversation_execution_exclusivity'
    and not t.tgisinternal;

  if agent_trigger_count <> 1 or direct_trigger_count <> 1 then
    raise exception 'execution exclusivity triggers are missing: agent %, direct %', agent_trigger_count, direct_trigger_count;
  end if;

  if not has_function_privilege('authenticated', 'public.prepare_direct_model_run(uuid,uuid,text,text,text,text)', 'execute') then
    raise exception 'authenticated cannot prepare direct model runs';
  end if;
  if not has_function_privilege('authenticated', 'public.direct_model_access_preflight(uuid,uuid,text)', 'execute') then
    raise exception 'authenticated cannot run direct model access preflight';
  end if;
  if not has_function_privilege('authenticated', 'public.get_conversation_selected_resource_ids(uuid)', 'execute') then
    raise exception 'authenticated cannot recover conversation resource ids';
  end if;
  if has_function_privilege('authenticated', 'public.complete_direct_model_run(uuid,text,bigint,bigint)', 'execute') then
    raise exception 'authenticated can forge direct model completion';
  end if;
  if has_function_privilege('authenticated', 'public.fail_direct_model_run(uuid,text)', 'execute') then
    raise exception 'authenticated can forge direct model failures';
  end if;
  if not has_function_privilege('service_role', 'public.complete_direct_model_run(uuid,text,bigint,bigint)', 'execute') then
    raise exception 'service role cannot complete direct model runs';
  end if;
end $$;
