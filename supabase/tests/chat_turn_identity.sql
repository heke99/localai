do $$
declare
  start_definition text;
  claim_definition text;
  complete_definition text;
  get_definition text;
  normalized_complete text;
  input_unique boolean;
  output_unique boolean;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='internal' and table_name='agent_runs' and column_name='input_message_id' and data_type='uuid'
  ) then
    raise exception 'agent run input_message_id is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='internal' and table_name='agent_runs' and column_name='output_message_id' and data_type='uuid'
  ) then
    raise exception 'agent run output_message_id is missing';
  end if;

  select i.indisunique into input_unique
  from pg_index i
  join pg_class c on c.oid=i.indexrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='internal' and c.relname='agent_runs_input_message_unique_idx';
  if not coalesce(input_unique,false) then
    raise exception 'input message uniqueness invariant is missing';
  end if;

  select i.indisunique into output_unique
  from pg_index i
  join pg_class c on c.oid=i.indexrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='internal' and c.relname='agent_runs_output_message_unique_idx';
  if not coalesce(output_unique,false) then
    raise exception 'output message uniqueness invariant is missing';
  end if;

  select pg_get_functiondef('public.start_agent_run(uuid,uuid,text,text,text,text,uuid[])'::regprocedure)
  into start_definition;
  if position('returning id into new_input_message_id' in lower(start_definition)) = 0
     or position('input_message_id' in lower(start_definition)) = 0 then
    raise exception 'start_agent_run does not bind the exact input message';
  end if;

  select pg_get_functiondef('public.worker_claim_agent_run(text)'::regprocedure)
  into claim_definition;
  if position('input_message.id = r.input_message_id' in lower(claim_definition)) = 0 then
    raise exception 'worker claim is not bound to the exact input message';
  end if;
  if position('order by msg.created_at desc' in lower(claim_definition)) > 0 then
    raise exception 'worker claim still relies on latest-message lookup';
  end if;

  select pg_get_functiondef('public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb)'::regprocedure)
  into complete_definition;
  normalized_complete := regexp_replace(lower(complete_definition), '\s+', '', 'g');
  if position('output_message_id=created_output_id' in normalized_complete) = 0
     or position('empty_model_response' in normalized_complete) = 0 then
    raise exception 'worker completion does not persist an exact non-empty output message';
  end if;

  select pg_get_functiondef('public.get_agent_run(uuid)'::regprocedure)
  into get_definition;
  if position('r.conversation_id' in lower(get_definition)) = 0
     or position('r.output_message_id' in lower(get_definition)) = 0 then
    raise exception 'get_agent_run does not expose exact conversation/output identity';
  end if;

  if has_function_privilege('authenticated', 'public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb)', 'execute') then
    raise exception 'authenticated can complete worker jobs';
  end if;
end $$;
