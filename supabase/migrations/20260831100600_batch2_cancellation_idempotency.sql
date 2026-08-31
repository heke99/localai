begin;

-- Durable integration operation state. A provider mutation is keyed by one stable
-- operation_id across retries; a completed operation is replayed, and a running
-- operation is never executed a second time.
alter table internal.integration_tool_execution_grants
  add column if not exists operation_id text,
  add column if not exists attempt integer not null default 1,
  add column if not exists execution_status text not null default 'queued',
  add column if not exists result_payload jsonb,
  add column if not exists retryable boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table internal.integration_tool_execution_grants
  drop constraint if exists integration_tool_execution_grants_execution_status_check;
alter table internal.integration_tool_execution_grants
  add constraint integration_tool_execution_grants_execution_status_check
  check (execution_status in ('queued','running','completed','failed','cancelled'));

create unique index if not exists integration_tool_execution_grants_operation_uidx
  on internal.integration_tool_execution_grants(operation_id)
  where operation_id is not null;

create index if not exists integration_tool_execution_grants_running_idx
  on internal.integration_tool_execution_grants(execution_status, updated_at)
  where execution_status = 'running';

create or replace function public.worker_create_idempotent_tool_execution_grant(
  target_run_id uuid,
  target_resource_id uuid,
  target_capability text,
  target_tool_name text,
  target_operation_id text,
  target_attempt integer default 1
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  authz jsonb;
  g internal.integration_tool_execution_grants%rowtype;
  normalized_attempt integer := greatest(coalesce(target_attempt,1),1);
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if coalesce(target_operation_id,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_operation_id';
  end if;

  authz := public.worker_authorize_tool_call(target_run_id,target_resource_id,target_capability);

  select * into g
  from internal.integration_tool_execution_grants
  where operation_id = target_operation_id
  for update;

  if found then
    if g.run_id <> target_run_id
       or g.resource_id <> target_resource_id
       or g.capability <> target_capability
       or g.tool_name <> left(target_tool_name,160)
       or g.provider <> authz->>'provider' then
      raise exception 'operation_id_context_mismatch' using errcode='42501';
    end if;

    if g.execution_status = 'failed' and g.retryable then
      update internal.integration_tool_execution_grants
      set execution_status='queued',
          attempt=greatest(g.attempt + 1, normalized_attempt),
          consumed_at=null,
          finished_at=null,
          outcome=null,
          retryable=false,
          expires_at=now()+interval '2 minutes',
          updated_at=now()
      where id=g.id
      returning * into g;
    elsif g.execution_status = 'queued' then
      update internal.integration_tool_execution_grants
      set attempt=greatest(g.attempt,normalized_attempt),
          expires_at=greatest(g.expires_at,now()+interval '2 minutes'),
          updated_at=now()
      where id=g.id
      returning * into g;
    end if;

    return authz || jsonb_build_object(
      'executionGrantId',g.id,
      'operationId',g.operation_id,
      'operationStatus',g.execution_status,
      'operationAttempt',g.attempt,
      'replayResult',case when g.execution_status='completed' then g.result_payload else null end,
      'expiresInSeconds',greatest(0,extract(epoch from (g.expires_at-now()))::integer)
    );
  end if;

  insert into internal.integration_tool_execution_grants(
    run_id,actor_user_id,resource_id,connection_id,provider,capability,tool_name,
    operation_id,attempt,execution_status
  ) values(
    target_run_id,(authz->>'actorId')::uuid,target_resource_id,(authz->>'connectionId')::uuid,
    authz->>'provider',target_capability,left(target_tool_name,160),target_operation_id,
    normalized_attempt,'queued'
  ) returning * into g;

  return authz || jsonb_build_object(
    'executionGrantId',g.id,
    'operationId',g.operation_id,
    'operationStatus',g.execution_status,
    'operationAttempt',g.attempt,
    'replayResult',null,
    'expiresInSeconds',120
  );
end $$;

revoke all on function public.worker_create_idempotent_tool_execution_grant(uuid,uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.worker_create_idempotent_tool_execution_grant(uuid,uuid,text,text,text,integer) to service_role;

create or replace function public.service_consume_idempotent_integration_tool_execution(
  target_grant_id uuid,
  target_tool_name text,
  target_operation_id text
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  g internal.integration_tool_execution_grants%rowtype;
  c internal.integration_connections%rowtype;
  r internal.integration_resources%rowtype;
  credential_text text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select * into g
  from internal.integration_tool_execution_grants
  where id=target_grant_id
    and tool_name=target_tool_name
    and operation_id=target_operation_id
  for update;
  if not found then raise exception 'execution_grant_invalid' using errcode='42501'; end if;

  if g.execution_status='completed' then
    return jsonb_build_object(
      'grantId',g.id,'operationId',g.operation_id,'executionStatus','completed',
      'executeAllowed',false,'result',g.result_payload
    );
  end if;
  if g.execution_status='running' then
    return jsonb_build_object(
      'grantId',g.id,'operationId',g.operation_id,'executionStatus','running',
      'executeAllowed',false
    );
  end if;
  if g.execution_status in ('failed','cancelled') then
    return jsonb_build_object(
      'grantId',g.id,'operationId',g.operation_id,'executionStatus',g.execution_status,
      'executeAllowed',false,'retryable',g.retryable
    );
  end if;
  if g.expires_at <= now() then raise exception 'execution_grant_expired' using errcode='42501'; end if;

  update internal.integration_tool_execution_grants
  set consumed_at=coalesce(consumed_at,now()),execution_status='running',updated_at=now()
  where id=g.id
  returning * into g;

  select * into c from internal.integration_connections
  where id=g.connection_id and status in ('connected','active','ready');
  select * into r from internal.integration_resources
  where id=g.resource_id and connection_id=g.connection_id and resource_status='available';
  if c.id is null or r.id is null then raise exception 'integration_resource_unavailable' using errcode='42501'; end if;
  if c.vault_secret_id is not null then
    select decrypted_secret into credential_text from vault.decrypted_secrets where id=c.vault_secret_id;
  end if;

  return jsonb_build_object(
    'grantId',g.id,'operationId',g.operation_id,'executionStatus','running','executeAllowed',true,
    'runId',g.run_id,'actorUserId',g.actor_user_id,'resourceId',g.resource_id,
    'connectionId',g.connection_id,'provider',g.provider,'capability',g.capability,
    'toolName',g.tool_name,'externalResourceId',r.external_id,
    'displayName',coalesce(r.display_name,r.external_id),'resourceMetadata',r.metadata,
    'connectionMetadata',c.metadata,
    'credential',case when credential_text is null then null else credential_text::jsonb end,
    'credentialExpiresAt',c.credential_expires_at
  );
end $$;

revoke all on function public.service_consume_idempotent_integration_tool_execution(uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_consume_idempotent_integration_tool_execution(uuid,text,text) to service_role;

create or replace function public.service_finish_idempotent_integration_tool_execution(
  target_grant_id uuid,
  target_operation_id text,
  target_outcome text,
  target_result_payload jsonb default null,
  target_result_metadata jsonb default '{}'::jsonb,
  target_retryable boolean default false
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  g internal.integration_tool_execution_grants%rowtype;
  org_id uuid;
  next_status text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select * into g from internal.integration_tool_execution_grants
  where id=target_grant_id and operation_id=target_operation_id
  for update;
  if not found then raise exception 'execution_grant_invalid' using errcode='42501'; end if;

  if g.execution_status='completed' then
    return jsonb_build_object('status','completed','result',g.result_payload);
  end if;

  next_status := case
    when target_outcome='completed' then 'completed'
    when target_outcome='cancelled' then 'cancelled'
    else 'failed'
  end;

  update internal.integration_tool_execution_grants
  set finished_at=now(),
      outcome=left(coalesce(target_outcome,next_status),40),
      execution_status=next_status,
      result_payload=case when next_status='completed' then target_result_payload else result_payload end,
      result_metadata=coalesce(target_result_metadata,'{}'::jsonb),
      retryable=case when next_status='failed' then coalesce(target_retryable,false) else false end,
      updated_at=now()
  where id=g.id
  returning * into g;

  select organization_id into org_id from internal.integration_connections where id=g.connection_id;
  insert into audit.audit_events(
    organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted
  ) values(
    org_id,g.actor_user_id,'integration.tool.executed','integration_resource',g.resource_id::text,
    coalesce(target_outcome,next_status),
    jsonb_build_object('provider',g.provider,'capability',g.capability,'tool',g.tool_name,
      'run_id',g.run_id,'operation_id',g.operation_id,'attempt',g.attempt)
      || coalesce(target_result_metadata,'{}'::jsonb)
  );

  return jsonb_build_object('status',g.execution_status,'result',g.result_payload,'retryable',g.retryable);
end $$;

revoke all on function public.service_finish_idempotent_integration_tool_execution(uuid,text,text,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.service_finish_idempotent_integration_tool_execution(uuid,text,text,jsonb,jsonb,boolean) to service_role;

-- The worker uses cancel_requested_at as the source of truth; cancelling is a
-- visible non-terminal state until every active tool row is terminal.
create or replace function public.worker_is_agent_run_cancelled(target_run_id uuid)
returns boolean
language plpgsql security definer set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  return exists(
    select 1 from internal.agent_runs r
    where r.id=target_run_id
      and (r.cancel_requested_at is not null or r.status::text in ('cancelling','cancelled'))
  );
end $$;
revoke all on function public.worker_is_agent_run_cancelled(uuid) from public,anon,authenticated;
grant execute on function public.worker_is_agent_run_cancelled(uuid) to service_role;

create or replace function public.worker_finalize_agent_run_cancellation(target_run_id uuid)
returns boolean
language plpgsql security definer set search_path=''
as $$
declare ready boolean;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select not exists(
    select 1 from internal.agent_tool_executions e
    where e.run_id=target_run_id
      and (e.status in ('created','queued','running','waiting','retrying','cancelling')
        or e.rollback_status not in ('not_required','completed'))
  ) into ready;

  if ready then
    update internal.agent_runs
    set status='cancelled'::internal.run_status,
        finished_at=coalesce(finished_at,now()),updated_at=now(),active_skill=null
    where id=target_run_id and cancel_requested_at is not null
      and status::text not in ('completed','failed','cancelled','timed_out');
    update internal.job_queue
    set status='cancelled'::internal.run_status,leased_until=null,updated_at=now(),
        last_error_code=coalesce(last_error_code,'run_cancelled')
    where run_id=target_run_id and status::text not in ('completed','failed','cancelled','timed_out');
  end if;
  return ready;
end $$;
revoke all on function public.worker_finalize_agent_run_cancellation(uuid) from public,anon,authenticated;
grant execute on function public.worker_finalize_agent_run_cancellation(uuid) to service_role;

create or replace function public.request_agent_run_cancellation(target_run_id uuid)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  r internal.agent_runs%rowtype;
  active_count integer;
  unsafe_rollback_count integer;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select * into r from internal.agent_runs where id=target_run_id for update;
  if not found or r.requested_by<>actor_id then raise exception 'run_not_found' using errcode='42501'; end if;
  if r.status::text in ('completed','failed','cancelled','timed_out') then
    return jsonb_build_object('runId',r.id,'status',r.status::text,'ready',r.status::text='cancelled');
  end if;

  update internal.agent_runs set cancel_requested_at=coalesce(cancel_requested_at,now()),
    status='cancelling'::internal.run_status,updated_at=now()
  where id=r.id;
  update internal.job_queue set status='cancelling'::internal.run_status,updated_at=now()
  where run_id=r.id and status::text not in ('completed','failed','cancelled','timed_out');

  select count(*) filter(where status in ('created','queued','running','waiting','retrying','cancelling')),
         count(*) filter(where rollback_status not in ('not_required','completed'))
  into active_count,unsafe_rollback_count
  from internal.agent_tool_executions where run_id=r.id;

  if active_count=0 and unsafe_rollback_count=0 then
    update internal.agent_runs set status='cancelled'::internal.run_status,
      finished_at=coalesce(finished_at,now()),updated_at=now(),active_skill=null where id=r.id;
    update internal.job_queue set status='cancelled'::internal.run_status,leased_until=null,updated_at=now(),
      last_error_code=coalesce(last_error_code,'run_cancelled') where run_id=r.id;
  end if;

  return jsonb_build_object('runId',r.id,'status',case when active_count=0 and unsafe_rollback_count=0 then 'cancelled' else 'cancelling' end,
    'ready',active_count=0 and unsafe_rollback_count=0,'activeToolExecutions',active_count,'unsafeRollbacks',unsafe_rollback_count);
end $$;
revoke all on function public.request_agent_run_cancellation(uuid) from public,anon;
grant execute on function public.request_agent_run_cancellation(uuid) to authenticated;

create or replace function public.prepare_conversation_delete(target_conversation_id uuid)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  workspace_id uuid; org_id uuid; creator_id uuid;
  active_count integer; unsafe_rollback_count integer; noncancelled_count integer;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select c.workspace_id,w.organization_id,c.created_by into workspace_id,org_id,creator_id
  from public.conversations c join public.workspaces w on w.id=c.workspace_id
  where c.id=target_conversation_id;
  if workspace_id is null then raise exception 'conversation_not_found'; end if;
  if not internal.is_workspace_member(workspace_id) then raise exception 'conversation_access_denied' using errcode='42501'; end if;
  if creator_id<>actor_id and not internal.has_permission(org_id,'project.write') then raise exception 'permission_denied' using errcode='42501'; end if;

  update internal.agent_runs set cancel_requested_at=coalesce(cancel_requested_at,now()),
    status='cancelling'::internal.run_status,updated_at=now()
  where conversation_id=target_conversation_id
    and status::text not in ('completed','failed','cancelled','timed_out');
  update internal.job_queue q set status='cancelling'::internal.run_status,updated_at=now()
  where q.run_id in (select id from internal.agent_runs where conversation_id=target_conversation_id)
    and q.status::text not in ('completed','failed','cancelled','timed_out');

  select count(*) filter(where e.status in ('created','queued','running','waiting','retrying','cancelling')),
         count(*) filter(where e.rollback_status not in ('not_required','completed'))
  into active_count,unsafe_rollback_count
  from internal.agent_tool_executions e
  join internal.agent_runs r on r.id=e.run_id
  where r.conversation_id=target_conversation_id;

  if active_count=0 and unsafe_rollback_count=0 then
    update internal.agent_runs set status='cancelled'::internal.run_status,
      finished_at=coalesce(finished_at,now()),updated_at=now(),active_skill=null
    where conversation_id=target_conversation_id and cancel_requested_at is not null
      and status::text not in ('completed','failed','cancelled','timed_out');
    update internal.job_queue q set status='cancelled'::internal.run_status,leased_until=null,updated_at=now(),
      last_error_code=coalesce(last_error_code,'conversation_cancelled')
    where q.run_id in (select id from internal.agent_runs where conversation_id=target_conversation_id)
      and q.status::text not in ('completed','failed','cancelled','timed_out');
  end if;

  select count(*) into noncancelled_count from internal.agent_runs
  where conversation_id=target_conversation_id and status::text not in ('completed','failed','cancelled','timed_out');
  return jsonb_build_object('ready',active_count=0 and unsafe_rollback_count=0 and noncancelled_count=0,
    'activeToolExecutions',active_count,'unsafeRollbacks',unsafe_rollback_count,'nonTerminalRuns',noncancelled_count);
end $$;
revoke all on function public.prepare_conversation_delete(uuid) from public,anon;
grant execute on function public.prepare_conversation_delete(uuid) to authenticated;

create or replace function public.prepare_project_delete(target_project_id uuid)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  workspace_id uuid; org_id uuid; creator_id uuid; system_kind text;
  active_count integer; unsafe_rollback_count integer; noncancelled_count integer;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select p.workspace_id,w.organization_id,p.created_by,p.system_kind into workspace_id,org_id,creator_id,system_kind
  from public.projects p join public.workspaces w on w.id=p.workspace_id where p.id=target_project_id;
  if workspace_id is null then raise exception 'project_not_found'; end if;
  if system_kind is not null then raise exception 'project_access_denied' using errcode='42501'; end if;
  if not internal.is_workspace_member(workspace_id) then raise exception 'project_access_denied' using errcode='42501'; end if;
  if creator_id<>actor_id and not internal.has_permission(org_id,'project.write') then raise exception 'permission_denied' using errcode='42501'; end if;

  update internal.agent_runs set cancel_requested_at=coalesce(cancel_requested_at,now()),
    status='cancelling'::internal.run_status,updated_at=now()
  where conversation_id in (select id from public.conversations where project_id=target_project_id)
    and status::text not in ('completed','failed','cancelled','timed_out');
  update internal.job_queue q set status='cancelling'::internal.run_status,updated_at=now()
  where q.run_id in (
    select r.id from internal.agent_runs r join public.conversations c on c.id=r.conversation_id where c.project_id=target_project_id
  ) and q.status::text not in ('completed','failed','cancelled','timed_out');

  select count(*) filter(where e.status in ('created','queued','running','waiting','retrying','cancelling')),
         count(*) filter(where e.rollback_status not in ('not_required','completed'))
  into active_count,unsafe_rollback_count
  from internal.agent_tool_executions e join internal.agent_runs r on r.id=e.run_id
  join public.conversations c on c.id=r.conversation_id where c.project_id=target_project_id;

  if active_count=0 and unsafe_rollback_count=0 then
    update internal.agent_runs r set status='cancelled'::internal.run_status,
      finished_at=coalesce(r.finished_at,now()),updated_at=now(),active_skill=null
    where r.conversation_id in (select id from public.conversations where project_id=target_project_id)
      and r.cancel_requested_at is not null and r.status::text not in ('completed','failed','cancelled','timed_out');
    update internal.job_queue q set status='cancelled'::internal.run_status,leased_until=null,updated_at=now(),
      last_error_code=coalesce(last_error_code,'project_cancelled')
    where q.run_id in (
      select r.id from internal.agent_runs r join public.conversations c on c.id=r.conversation_id where c.project_id=target_project_id
    ) and q.status::text not in ('completed','failed','cancelled','timed_out');
  end if;

  select count(*) into noncancelled_count from internal.agent_runs r
  join public.conversations c on c.id=r.conversation_id
  where c.project_id=target_project_id and r.status::text not in ('completed','failed','cancelled','timed_out');
  return jsonb_build_object('ready',active_count=0 and unsafe_rollback_count=0 and noncancelled_count=0,
    'activeToolExecutions',active_count,'unsafeRollbacks',unsafe_rollback_count,'nonTerminalRuns',noncancelled_count);
end $$;
revoke all on function public.prepare_project_delete(uuid) from public,anon;
grant execute on function public.prepare_project_delete(uuid) to authenticated;

-- Last-line protection: no code path may physically remove a run while a tool is
-- active or rollback evidence is unresolved.
create or replace function internal.guard_agent_run_delete()
returns trigger language plpgsql set search_path=''
as $$
begin
  if exists(
    select 1 from internal.agent_tool_executions e
    where e.run_id=old.id and (
      e.status in ('created','queued','running','waiting','retrying','cancelling')
      or e.rollback_status not in ('not_required','completed')
    )
  ) then
    raise exception 'agent_run_delete_not_ready';
  end if;
  return old;
end $$;

drop trigger if exists guard_agent_run_delete on internal.agent_runs;
create trigger guard_agent_run_delete before delete on internal.agent_runs
for each row execute function internal.guard_agent_run_delete();

commit;
