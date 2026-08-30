-- Canonical, same-row lifecycle for every model tool call.
-- Generic agent_run_steps remain an append-only trace; UI activity is driven from this table.

create table if not exists public.agent_tool_executions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  tool_call_id text not null,
  operation_id text not null,
  tool_name text not null,
  status text not null check (status in ('created','queued','running','waiting','retrying','cancelling','completed','failed','cancelled','blocked')),
  attempt integer not null default 1 check (attempt > 0),
  started_at timestamptz,
  finished_at timestamptz,
  input_hash text not null,
  input_redacted jsonb not null default '{}'::jsonb,
  output_summary jsonb,
  error_code text,
  retryable boolean not null default false,
  mutating boolean not null default false,
  reversible boolean not null default false,
  rollback_status text not null default 'not_required' check (rollback_status in ('not_required','pending','running','completed','failed')),
  scope_snapshot jsonb,
  provider_resource_id text,
  external_operation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, tool_call_id),
  unique (operation_id)
);

create index if not exists agent_tool_executions_run_status_idx
  on public.agent_tool_executions(run_id, status, created_at);

alter table public.agent_tool_executions enable row level security;

-- Direct client mutation is deliberately denied. Workers use SECURITY DEFINER RPCs.
revoke all on public.agent_tool_executions from anon, authenticated;

grant select on public.agent_tool_executions to authenticated;

create policy agent_tool_executions_select_own_run
  on public.agent_tool_executions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.agent_runs r
      where r.id = agent_tool_executions.run_id
        and r.user_id = auth.uid()
    )
  );

create or replace function public.worker_begin_agent_tool_execution(
  target_run_id uuid,
  target_tool_call_id text,
  target_operation_id text,
  target_tool_name text,
  target_input_hash text,
  target_input_redacted jsonb default '{}'::jsonb,
  target_mutating boolean default false,
  target_reversible boolean default false,
  target_scope_snapshot jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  execution_id uuid;
begin
  insert into public.agent_tool_executions (
    run_id, tool_call_id, operation_id, tool_name, status, input_hash,
    input_redacted, mutating, reversible, scope_snapshot
  ) values (
    target_run_id, target_tool_call_id, target_operation_id, target_tool_name,
    'queued', target_input_hash, coalesce(target_input_redacted, '{}'::jsonb),
    target_mutating, target_reversible, target_scope_snapshot
  )
  on conflict (run_id, tool_call_id) do update
    set updated_at = now()
  returning id into execution_id;

  return execution_id;
end;
$$;

create or replace function public.worker_transition_agent_tool_execution(
  target_execution_id uuid,
  target_status text,
  target_attempt integer default null,
  target_output_summary jsonb default null,
  target_error_code text default null,
  target_retryable boolean default null,
  target_provider_resource_id text default null,
  target_external_operation_id text default null,
  target_rollback_status text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_status text;
begin
  if target_status not in ('created','queued','running','waiting','retrying','cancelling','completed','failed','cancelled','blocked') then
    raise exception 'invalid_tool_execution_status';
  end if;

  select status into previous_status
  from public.agent_tool_executions
  where id = target_execution_id
  for update;

  if previous_status is null then
    raise exception 'tool_execution_not_found';
  end if;

  if previous_status in ('completed','cancelled','blocked') and target_status <> previous_status then
    raise exception 'terminal_tool_execution_transition';
  end if;

  update public.agent_tool_executions
  set status = target_status,
      attempt = coalesce(target_attempt, attempt),
      started_at = case when target_status = 'running' then coalesce(started_at, now()) else started_at end,
      finished_at = case when target_status in ('completed','failed','cancelled','blocked') then now() else null end,
      output_summary = coalesce(target_output_summary, output_summary),
      error_code = target_error_code,
      retryable = coalesce(target_retryable, retryable),
      provider_resource_id = coalesce(target_provider_resource_id, provider_resource_id),
      external_operation_id = coalesce(target_external_operation_id, external_operation_id),
      rollback_status = coalesce(target_rollback_status, rollback_status),
      updated_at = now()
  where id = target_execution_id;
end;
$$;

revoke all on function public.worker_begin_agent_tool_execution(uuid,text,text,text,text,jsonb,boolean,boolean,jsonb) from public;
revoke all on function public.worker_transition_agent_tool_execution(uuid,text,integer,jsonb,text,boolean,text,text,text) from public;
grant execute on function public.worker_begin_agent_tool_execution(uuid,text,text,text,text,jsonb,boolean,boolean,jsonb) to service_role;
grant execute on function public.worker_transition_agent_tool_execution(uuid,text,integer,jsonb,text,boolean,text,text,text) to service_role;
