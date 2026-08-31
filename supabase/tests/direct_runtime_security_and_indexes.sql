do $$
begin
  if has_function_privilege('anon', 'public.get_agent_run(uuid)', 'execute') then
    raise exception 'anon can execute get_agent_run';
  end if;
  if has_function_privilege('anon', 'public.get_agent_run_stream(uuid)', 'execute') then
    raise exception 'anon can execute get_agent_run_stream';
  end if;
  if not has_function_privilege('authenticated', 'public.get_agent_run(uuid)', 'execute') then
    raise exception 'authenticated cannot execute get_agent_run';
  end if;
  if not has_function_privilege('authenticated', 'public.get_agent_run_stream(uuid)', 'execute') then
    raise exception 'authenticated cannot execute get_agent_run_stream';
  end if;
  if not has_function_privilege('service_role', 'public.get_agent_run(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.get_agent_run_stream(uuid)', 'execute') then
    raise exception 'service role cannot execute run read RPCs';
  end if;

  if to_regclass('internal.direct_model_runs_organization_idx') is null then
    raise exception 'direct model organization index is missing';
  end if;
  if to_regclass('internal.direct_model_runs_input_message_idx') is null then
    raise exception 'direct model input message index is missing';
  end if;
  if to_regclass('internal.direct_model_runs_output_message_idx') is null then
    raise exception 'direct model output message index is missing';
  end if;
end $$;
