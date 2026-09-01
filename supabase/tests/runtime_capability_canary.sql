begin;

select plan(12);

select has_function('public', 'service_runtime_canary_target', array[]::text[], 'service runtime canary target exists');
select has_function('public', 'service_delete_runtime_canary_tool_execution', array['text'], 'service canary cleanup exists');
select has_function('public', 'service_prune_runtime_canary_tool_executions', array['text'], 'service canary prune exists');
select ok(has_function_privilege('service_role', 'public.service_runtime_canary_target()', 'EXECUTE'), 'service_role can resolve canary target');
select ok(not has_function_privilege('authenticated', 'public.service_runtime_canary_target()', 'EXECUTE'), 'authenticated cannot resolve canary target');
select ok(not has_function_privilege('anon', 'public.service_runtime_canary_target()', 'EXECUTE'), 'anon cannot resolve canary target');
select ok(has_function_privilege('service_role', 'public.service_delete_runtime_canary_tool_execution(text)', 'EXECUTE'), 'service_role can clean failed canary tool execution');
select ok(not has_function_privilege('authenticated', 'public.service_delete_runtime_canary_tool_execution(text)', 'EXECUTE'), 'authenticated cannot clean canary tool execution');
select ok(not has_function_privilege('anon', 'public.service_delete_runtime_canary_tool_execution(text)', 'EXECUTE'), 'anon cannot clean canary tool execution');
select ok(has_function_privilege('service_role', 'public.service_prune_runtime_canary_tool_executions(text)', 'EXECUTE'), 'service_role can retain only the latest canary');
select ok(not has_function_privilege('authenticated', 'public.service_prune_runtime_canary_tool_executions(text)', 'EXECUTE'), 'authenticated cannot prune canary history');
select ok(not has_function_privilege('anon', 'public.service_prune_runtime_canary_tool_executions(text)', 'EXECUTE'), 'anon cannot prune canary history');

select * from finish();
rollback;
