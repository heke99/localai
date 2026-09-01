do $$
begin
  if to_regprocedure('public.service_runtime_canary_target()') is null then raise exception 'service_runtime_canary_target_missing'; end if;
  if to_regprocedure('public.service_delete_runtime_canary_tool_execution(text)') is null then raise exception 'service_delete_runtime_canary_tool_execution_missing'; end if;
  if to_regprocedure('public.service_prune_runtime_canary_tool_executions(text)') is null then raise exception 'service_prune_runtime_canary_tool_executions_missing'; end if;

  if not has_function_privilege('service_role', 'public.service_runtime_canary_target()', 'EXECUTE') then raise exception 'service_runtime_canary_target_service_grant_missing'; end if;
  if has_function_privilege('authenticated', 'public.service_runtime_canary_target()', 'EXECUTE') then raise exception 'authenticated_runtime_canary_target_execute'; end if;
  if has_function_privilege('anon', 'public.service_runtime_canary_target()', 'EXECUTE') then raise exception 'anon_runtime_canary_target_execute'; end if;

  if not has_function_privilege('service_role', 'public.service_delete_runtime_canary_tool_execution(text)', 'EXECUTE') then raise exception 'service_delete_canary_service_grant_missing'; end if;
  if has_function_privilege('authenticated', 'public.service_delete_runtime_canary_tool_execution(text)', 'EXECUTE') then raise exception 'authenticated_delete_canary_execute'; end if;
  if has_function_privilege('anon', 'public.service_delete_runtime_canary_tool_execution(text)', 'EXECUTE') then raise exception 'anon_delete_canary_execute'; end if;

  if not has_function_privilege('service_role', 'public.service_prune_runtime_canary_tool_executions(text)', 'EXECUTE') then raise exception 'service_prune_canary_service_grant_missing'; end if;
  if has_function_privilege('authenticated', 'public.service_prune_runtime_canary_tool_executions(text)', 'EXECUTE') then raise exception 'authenticated_prune_canary_execute'; end if;
  if has_function_privilege('anon', 'public.service_prune_runtime_canary_tool_executions(text)', 'EXECUTE') then raise exception 'anon_prune_canary_execute'; end if;
end $$;
