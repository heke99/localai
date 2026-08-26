do $$
declare
  conversation_delete_definition text;
  project_delete_definition text;
  normalized_conversation text;
  normalized_project text;
begin
  select pg_get_functiondef('public.delete_conversation(uuid)'::regprocedure)
    into conversation_delete_definition;
  select pg_get_functiondef('public.delete_project(uuid)'::regprocedure)
    into project_delete_definition;

  normalized_conversation := regexp_replace(lower(conversation_delete_definition), '\s+', '', 'g');
  normalized_project := regexp_replace(lower(project_delete_definition), '\s+', '', 'g');

  if position('conversation_has_active_run' in normalized_conversation) > 0 then
    raise exception 'conversation deletion still blocks on active runs';
  end if;
  if position('project_has_active_run' in normalized_project) > 0 then
    raise exception 'project deletion still blocks on active runs';
  end if;

  if position('status=''cancelled''::internal.run_status' in normalized_conversation) = 0
     or position('deletefrominternal.agent_runs' in normalized_conversation) = 0
     or position('updateinternal.usage_events' in normalized_conversation) = 0
     or position('updatetraining.dataset_candidates' in normalized_conversation) = 0 then
    raise exception 'conversation deletion does not safely release runtime history';
  end if;

  if position('status=''cancelled''::internal.run_status' in normalized_project) = 0
     or position('deletefrominternal.agent_runs' in normalized_project) = 0
     or position('deletefrompublic.conversations' in normalized_project) = 0 then
    raise exception 'project deletion does not safely remove child chats/runs';
  end if;

  if position('target_created_by<>actor_id' in normalized_project) = 0 then
    raise exception 'project creator delete authorization is missing';
  end if;

  if position('system_kindisnotnull' in normalized_project) = 0 then
    raise exception 'hidden system project deletion protection is missing';
  end if;

  if not has_function_privilege('authenticated', 'public.delete_conversation(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.delete_project(uuid)', 'execute') then
    raise exception 'authenticated users cannot invoke guarded delete RPCs';
  end if;

  if has_function_privilege('anon', 'public.delete_conversation(uuid)', 'execute')
     or has_function_privilege('anon', 'public.delete_project(uuid)', 'execute') then
    raise exception 'anon can invoke destructive delete RPCs';
  end if;
end $$;
