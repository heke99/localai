begin;

-- A run is a single immutable turn inside one conversation. Bind the run to the
-- exact user message it consumes and the exact assistant message it produces so
-- neither the worker nor the UI ever has to guess using "latest message".
alter table internal.agent_runs
  add column if not exists input_message_id uuid,
  add column if not exists output_message_id uuid;

-- Existing runs were created immediately after their user message. Backfill the
-- input deterministically from the closest preceding user message. Output is not
-- guessed here; new completions always persist output_message_id explicitly.
update internal.agent_runs r
set input_message_id = (
  select m.id
  from public.messages m
  where m.conversation_id = r.conversation_id
    and m.role = 'user'
    and m.created_at <= r.created_at
  order by m.created_at desc, m.id desc
  limit 1
)
where r.input_message_id is null;

alter table internal.agent_runs
  drop constraint if exists agent_runs_input_message_fk,
  drop constraint if exists agent_runs_output_message_fk;

alter table internal.agent_runs
  add constraint agent_runs_input_message_fk
    foreign key (input_message_id) references public.messages(id) on delete restrict,
  add constraint agent_runs_output_message_fk
    foreign key (output_message_id) references public.messages(id) on delete restrict;

create unique index if not exists agent_runs_input_message_unique_idx
  on internal.agent_runs(input_message_id)
  where input_message_id is not null;

create unique index if not exists agent_runs_output_message_unique_idx
  on internal.agent_runs(output_message_id)
  where output_message_id is not null;

-- Conversation identity on a run is immutable. Also validate that the linked
-- input/output messages belong to this exact conversation and have the right role.
create or replace function internal.enforce_agent_run_turn_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.conversation_id is distinct from old.conversation_id
    or new.organization_id is distinct from old.organization_id
    or new.requested_by is distinct from old.requested_by
    or new.request_id is distinct from old.request_id
    or new.trace_id is distinct from old.trace_id
    or new.mode is distinct from old.mode
    or new.input_message_id is distinct from old.input_message_id
    or (old.output_message_id is not null and new.output_message_id is distinct from old.output_message_id)
  ) then
    raise exception 'agent_run_identity_is_immutable' using errcode = '23514';
  end if;

  if new.conversation_id is null then
    raise exception 'agent_run_conversation_required' using errcode = '23514';
  end if;

  if new.input_message_id is null or not exists (
    select 1
    from public.messages m
    where m.id = new.input_message_id
      and m.conversation_id = new.conversation_id
      and m.role = 'user'
  ) then
    raise exception 'agent_run_input_message_mismatch' using errcode = '23514';
  end if;

  if new.output_message_id is not null and not exists (
    select 1
    from public.messages m
    where m.id = new.output_message_id
      and m.conversation_id = new.conversation_id
      and m.role = 'assistant'
  ) then
    raise exception 'agent_run_output_message_mismatch' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function internal.enforce_agent_run_turn_identity() from public, anon, authenticated;
grant execute on function internal.enforce_agent_run_turn_identity() to service_role;

drop trigger if exists agent_runs_turn_identity_immutable on internal.agent_runs;
create trigger agent_runs_turn_identity_immutable
before insert or update on internal.agent_runs
for each row execute function internal.enforce_agent_run_turn_identity();

-- New requests capture the exact user-message id before creating the run.
create or replace function public.start_agent_run(
  workspace_id uuid,
  conversation_id uuid,
  mode text,
  prompt text,
  request_id text,
  trace_id text,
  resource_ids uuid[] default null::uuid[]
)
returns table(run_id uuid, resolved_conversation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  target_conversation_id uuid := conversation_id;
  target_project_id uuid;
  conversation_mode text;
  selected_alias text;
  new_run_id uuid;
  new_input_message_id uuid;
  resources jsonb;
begin
  if actor_id is null then raise exception 'authentication_required'; end if;
  if mode not in ('chat','code','lab','research') then raise exception 'invalid_mode'; end if;
  if char_length(trim(prompt)) < 1 or char_length(prompt) > 100000 then raise exception 'invalid_prompt'; end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id = workspace_id
    and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied'; end if;
  if not internal.has_permission(org_id, case when mode='lab' then 'lab.run' else 'agent.run' end) then raise exception 'permission_denied'; end if;
  if not internal.current_actor_has_agent_access(org_id) then raise exception 'subscription_access_required' using errcode='42501'; end if;

  if target_conversation_id is null then
    target_project_id := internal.ensure_standalone_project(workspace_id, actor_id);
    insert into public.conversations(workspace_id, project_id, created_by, mode, title)
    values(workspace_id, target_project_id, actor_id, mode, left(trim(prompt),100))
    returning id, public.conversations.mode into target_conversation_id, conversation_mode;
  else
    select c.project_id, c.mode into target_project_id, conversation_mode
    from public.conversations c
    where c.id = target_conversation_id
      and c.workspace_id = start_agent_run.workspace_id;
    if not found then raise exception 'conversation_access_denied'; end if;
    if conversation_mode <> mode then raise exception 'conversation_mode_mismatch'; end if;
    if target_project_id is null then
      target_project_id := internal.ensure_standalone_project(workspace_id, actor_id);
      update public.conversations set project_id = target_project_id where id = target_conversation_id;
    end if;
    update public.conversations c
    set title = case when c.title is null or c.title='Ny chatt' then left(trim(prompt),100) else c.title end,
        updated_at = now()
    where c.id = target_conversation_id;
  end if;

  if resource_ids is not null then
    perform public.set_conversation_resources(target_conversation_id, resource_ids);
  end if;

  insert into public.messages(conversation_id, actor_user_id, role, content)
  values(target_conversation_id, actor_id, 'user', jsonb_build_object('text', prompt))
  returning id into new_input_message_id;

  resources := internal.resource_context_for_conversation(target_conversation_id);
  selected_alias := case mode when 'code' then 'code-prod' when 'lab' then 'lab-prod' when 'research' then 'research-prod' else 'general-prod' end;

  insert into internal.agent_runs(
    conversation_id, organization_id, requested_by, status, request_id, trace_id,
    model_alias, mode, resource_context, input_message_id
  )
  values(
    target_conversation_id, org_id, actor_id, 'queued', request_id, trace_id,
    selected_alias, mode, resources, new_input_message_id
  )
  returning id into new_run_id;

  insert into audit.audit_events(
    organization_id, actor_user_id, request_id, trace_id, event_type,
    target_type, target_id, outcome, metadata_redacted
  )
  values(
    org_id, actor_id, request_id, trace_id, 'agent.run.requested',
    'agent_run', new_run_id::text, 'accepted',
    jsonb_build_object('mode',mode,'project_id',target_project_id,'conversation_id',target_conversation_id,'input_message_id',new_input_message_id,'resource_count',jsonb_array_length(resources))
  );

  return query select new_run_id, target_conversation_id;
end;
$$;

-- Workers consume the exact input message bound to the claimed run. There is no
-- lateral "latest user message" lookup anymore.
drop function if exists public.worker_claim_agent_run(text);
create function public.worker_claim_agent_run(worker_id text)
returns table(
  job_id uuid,
  run_id uuid,
  conversation_id uuid,
  organization_id uuid,
  requested_by uuid,
  mode text,
  model_alias text,
  prompt text,
  request_id text,
  trace_id text,
  resource_context jsonb
)
language plpgsql
security definer
set search_path=''
as $$
declare
  candidate record;
  claimed_job internal.job_queue%rowtype;
begin
  for candidate in
    select q.id as job_id, r.requested_by
    from internal.job_queue q
    join internal.agent_runs r on r.id = q.run_id
    join public.messages input_message
      on input_message.id = r.input_message_id
     and input_message.conversation_id = r.conversation_id
     and input_message.role = 'user'
    where q.queue = 'agent-runs'
      and q.status in ('queued','retrying')
      and q.available_at <= now()
      and (q.leased_until is null or q.leased_until < now())
      and r.status in ('queued','retrying')
      and not exists (
        select 1
        from internal.agent_runs active
        where active.requested_by = r.requested_by
          and active.status in ('planning','running','waiting_for_tool','verifying')
      )
    order by q.priority asc, q.created_at asc
    for update of q skip locked
  loop
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.requested_by::text, 0)) then
      continue;
    end if;

    if exists (
      select 1
      from internal.agent_runs active
      where active.requested_by = candidate.requested_by
        and active.status in ('planning','running','waiting_for_tool','verifying')
    ) then
      continue;
    end if;

    select * into claimed_job
    from internal.job_queue q
    where q.id = candidate.job_id;

    perform 1
    from internal.agent_runs r
    where r.id = claimed_job.run_id
      and r.status in ('queued','retrying')
    for update;
    if not found then continue; end if;

    update internal.job_queue q
    set status='running', leased_by=worker_id, leased_until=now()+interval '2 minutes',
        attempts=attempts+1, updated_at=now()
    where q.id=claimed_job.id;

    update internal.agent_runs r
    set status='planning', started_at=coalesce(started_at,now()), updated_at=now()
    where r.id=claimed_job.run_id and r.status in ('queued','retrying');

    return query
    select claimed_job.id,
           r.id,
           r.conversation_id,
           r.organization_id,
           r.requested_by,
           r.mode,
           r.model_alias,
           coalesce(input_message.content->>'text',''),
           r.request_id,
           r.trace_id,
           r.resource_context
    from internal.agent_runs r
    join public.messages input_message
      on input_message.id = r.input_message_id
     and input_message.conversation_id = r.conversation_id
     and input_message.role = 'user'
    where r.id = claimed_job.run_id;
    return;
  end loop;
  return;
end $$;

-- Completion writes exactly one assistant message and stores its id on the run.
-- Repeated completion calls are idempotent and cannot create duplicate replies.
create or replace function public.worker_complete_agent_run(
  target_run_id uuid,
  target_job_id uuid,
  output_content text,
  model_version uuid default null,
  usage jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  conv_id uuid;
  org_id uuid;
  actor_id uuid;
  req_id text;
  tr_id text;
  existing_output_id uuid;
  created_output_id uuid;
  existing_status internal.run_status;
begin
  select conversation_id, organization_id, requested_by, request_id, trace_id, output_message_id, status
  into conv_id, org_id, actor_id, req_id, tr_id, existing_output_id, existing_status
  from internal.agent_runs
  where id = target_run_id
  for update;

  if conv_id is null then raise exception 'agent_run_not_found'; end if;
  if not exists(select 1 from internal.job_queue q where q.id=target_job_id and q.run_id=target_run_id) then
    raise exception 'agent_job_run_mismatch';
  end if;

  if existing_status = 'completed' then
    if existing_output_id is null then raise exception 'completed_run_missing_output_message'; end if;
    update internal.job_queue set status='completed', leased_until=null, updated_at=now()
    where id=target_job_id and run_id=target_run_id;
    return;
  end if;

  if nullif(trim(coalesce(output_content,'')), '') is null then
    raise exception 'empty_model_response';
  end if;

  if existing_output_id is null then
    insert into public.messages(conversation_id, role, content, model_version_id)
    values(conv_id, 'assistant', jsonb_build_object('text',output_content), model_version)
    returning id into created_output_id;
  else
    created_output_id := existing_output_id;
  end if;

  update internal.agent_runs
  set output_message_id=created_output_id,
      status='completed', finished_at=now(), updated_at=now(), active_skill=null
  where id=target_run_id;

  update internal.job_queue
  set status='completed', leased_until=null, updated_at=now()
  where id=target_job_id and run_id=target_run_id;

  insert into internal.usage_events(
    organization_id,user_id,run_id,model_version_id,input_tokens,output_tokens,cached_tokens,gpu_seconds,queue_ms
  )
  values(
    org_id,actor_id,target_run_id,model_version,
    coalesce((usage->>'inputTokens')::bigint,0),
    coalesce((usage->>'outputTokens')::bigint,0),
    coalesce((usage->>'cachedTokens')::bigint,0),
    coalesce((usage->>'gpuSeconds')::numeric,0),
    coalesce((usage->>'queueMs')::integer,0)
  );

  insert into audit.audit_events(
    organization_id,actor_user_id,request_id,trace_id,event_type,target_type,target_id,outcome,metadata_redacted
  )
  values(
    org_id,actor_id,req_id,tr_id,'agent.run.completed','agent_run',target_run_id::text,'success',
    jsonb_build_object('conversation_id',conv_id,'input_message_id',(select input_message_id from internal.agent_runs where id=target_run_id),'output_message_id',created_output_id)
  );
end $$;

-- UI polling now receives the run's immutable conversation id and exact output
-- message, rather than whichever assistant message happens to be latest.
drop function if exists public.get_agent_run(uuid);
create function public.get_agent_run(target_run_id uuid)
returns table(
  id uuid,
  status text,
  mode text,
  model_alias text,
  failure_code text,
  cancel_requested_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  output_content text,
  conversation_id uuid,
  input_message_id uuid,
  output_message_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id,
         r.status::text,
         r.mode,
         r.model_alias,
         r.failure_code,
         r.cancel_requested_at,
         r.created_at,
         r.updated_at,
         coalesce(
           exact_output.content->>'text',
           (
             select legacy.content->>'text'
             from public.messages legacy
             where r.output_message_id is null
               and legacy.conversation_id=r.conversation_id
               and legacy.role='assistant'
               and legacy.created_at >= r.created_at
               and legacy.created_at < coalesce(
                 (select min(next_run.created_at) from internal.agent_runs next_run where next_run.conversation_id=r.conversation_id and next_run.created_at>r.created_at),
                 'infinity'::timestamptz
               )
             order by legacy.created_at asc, legacy.id asc
             limit 1
           )
         ) as output_content,
         r.conversation_id,
         r.input_message_id,
         r.output_message_id
  from internal.agent_runs r
  left join public.messages exact_output
    on exact_output.id=r.output_message_id
   and exact_output.conversation_id=r.conversation_id
   and exact_output.role='assistant'
  where r.id=target_run_id
    and (r.requested_by=(select auth.uid()) or internal.is_superadmin())
$$;

revoke all on function public.start_agent_run(uuid,uuid,text,text,text,text,uuid[]) from public,anon;
grant execute on function public.start_agent_run(uuid,uuid,text,text,text,text,uuid[]) to authenticated;
revoke all on function public.worker_claim_agent_run(text) from public,anon,authenticated;
grant execute on function public.worker_claim_agent_run(text) to service_role;
revoke all on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.worker_complete_agent_run(uuid,uuid,text,uuid,jsonb) to service_role;
revoke all on function public.get_agent_run(uuid) from public;
grant execute on function public.get_agent_run(uuid) to authenticated;

commit;
