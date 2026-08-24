do $$
declare
  index_is_unique boolean;
  index_predicate text;
  claim_definition text;
begin
  select i.indisunique, pg_get_expr(i.indpred, i.indrelid)
  into index_is_unique, index_predicate
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'internal'
    and c.relname = 'agent_runs_one_active_execution_per_user_idx';

  if not coalesce(index_is_unique, false) then
    raise exception 'single-active-run index is missing or is not unique';
  end if;
  if index_predicate is null
     or position('planning' in index_predicate) = 0
     or position('running' in index_predicate) = 0
     or position('waiting_for_tool' in index_predicate) = 0
     or position('verifying' in index_predicate) = 0 then
    raise exception 'single-active-run index does not cover all worker-owned states: %', index_predicate;
  end if;

  select pg_get_functiondef('public.worker_claim_agent_run(text)'::regprocedure)
  into claim_definition;
  if position('pg_try_advisory_xact_lock' in claim_definition) = 0 then
    raise exception 'worker claim lacks per-user transaction lock';
  end if;
  if position('active.requested_by' in claim_definition) = 0
     or position('waiting_for_tool' in claim_definition) = 0
     or position('verifying' in claim_definition) = 0 then
    raise exception 'worker claim lacks active-run exclusion';
  end if;

  if has_function_privilege('authenticated', 'public.worker_claim_agent_run(text)', 'execute') then
    raise exception 'authenticated can claim worker jobs';
  end if;
end $$;
