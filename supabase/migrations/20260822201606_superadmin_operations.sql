begin;

create table internal.repository_indexes (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references public.project_repositories(id) on delete cascade,
  revision text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('queued','indexing','ready','failed','superseded')),
  report jsonb not null default '{}',
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (repository_id, revision)
);
create table internal.repository_files (
  id uuid primary key default gen_random_uuid(),
  index_id uuid not null references internal.repository_indexes(id) on delete cascade,
  path text not null,
  language text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  storage_path text not null,
  metadata jsonb not null default '{}',
  unique (index_id, path)
);
create table internal.repository_symbols (
  id bigint generated always as identity primary key,
  file_id uuid not null references internal.repository_files(id) on delete cascade,
  name text not null,
  kind text not null,
  line_start integer not null check (line_start > 0),
  line_end integer not null check (line_end >= line_start),
  signature text,
  search_document tsvector generated always as (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(signature, ''))) stored
);
create index repository_symbols_search_idx on internal.repository_symbols using gin (search_document);
create index repository_files_index_idx on internal.repository_files(index_id);

create table internal.observability_events (
  id bigint generated always as identity primary key,
  trace_id text not null,
  run_id uuid references internal.agent_runs(id) on delete set null,
  service text not null,
  event_name text not null,
  severity text not null check (severity in ('debug','info','warn','error')),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  attributes_redacted jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index observability_trace_time_idx on internal.observability_events(trace_id, occurred_at);
create index observability_run_time_idx on internal.observability_events(run_id, occurred_at) where run_id is not null;

create table training.training_plans (
  id uuid primary key default gen_random_uuid(),
  training_run_id uuid not null unique references training.training_runs(id) on delete cascade,
  method text not null check (method in ('lora','qlora')),
  container_digest text not null check (container_digest ~ '@sha256:[a-f0-9]{64}$'),
  command_arguments jsonb not null,
  manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
  compute_profile text not null,
  output_uri text not null,
  created_at timestamptz not null default now()
);

alter table internal.repository_indexes enable row level security;
alter table internal.repository_files enable row level security;
alter table internal.repository_symbols enable row level security;
alter table internal.observability_events enable row level security;
alter table training.training_plans enable row level security;
grant all on internal.repository_indexes, internal.repository_files, internal.repository_symbols, internal.observability_events, training.training_plans to service_role;
grant usage, select on all sequences in schema internal to service_role;

create or replace function public.superadmin_overview() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'access_requests', (select jsonb_build_object('pending', count(*) filter (where status = 'pending'), 'reviewing', count(*) filter (where status = 'reviewing')) from public.access_requests),
    'runs', (select jsonb_build_object('queued', count(*) filter (where status = 'queued'), 'running', count(*) filter (where status = 'running'), 'failed', count(*) filter (where status = 'failed')) from internal.agent_runs),
    'knowledge', (select jsonb_build_object('pending', count(*) filter (where approval_status = 'pending'), 'approved', count(*) filter (where approval_status = 'approved')) from internal.knowledge_sources),
    'models', (select coalesce(jsonb_agg(jsonb_build_object('version', mv.version_key, 'status', mv.status, 'repository', mv.repository, 'revision', mv.revision, 'quantization', ma.quantization)), '[]'::jsonb) from internal.model_versions mv left join internal.model_artifacts ma on ma.model_version_id = mv.id),
    'workers', (select jsonb_build_object('ready', count(*) filter (where state = 'ready'), 'total', count(*)) from internal.gpu_workers),
    'queues', (select coalesce(jsonb_object_agg(queue, count), '{}'::jsonb) from (select queue, count(*) from internal.job_queue where status in ('queued','running') group by queue) q),
    'recent_errors', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select trace_id, service, event_name, occurred_at from internal.observability_events where severity = 'error' order by occurred_at desc limit 20) e)
  );
end;
$$;

create or replace function public.superadmin_review_access_request(target_id uuid, decision public.access_request_status) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode = '42501'; end if;
  if decision not in ('reviewing','approved','rejected') then raise exception 'invalid_access_decision'; end if;
  update public.access_requests set status = decision, reviewed_by = (select auth.uid()), reviewed_at = now() where id = target_id;
  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values ((select auth.uid()),'access_request.reviewed','access_request',target_id::text,'completed',jsonb_build_object('decision',decision));
  return found;
end;
$$;

create or replace function public.superadmin_enqueue_operation(target_queue text, operation_payload jsonb, operation_key text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare created_id uuid;
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode = '42501'; end if;
  if target_queue not in ('knowledge-ingestion','repository-index','eval','training','gpu-reconcile','rollback') then raise exception 'operation_queue_not_allowed'; end if;
  if operation_payload is null or jsonb_typeof(operation_payload) <> 'object' then raise exception 'operation_payload_invalid'; end if;
  insert into internal.job_queue(queue,payload,dedupe_key) values (target_queue,operation_payload,operation_key) on conflict (queue,dedupe_key) do update set payload = excluded.payload returning id into created_id;
  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values ((select auth.uid()),'operation.enqueued','job',created_id::text,'completed',jsonb_build_object('queue',target_queue));
  return created_id;
end;
$$;

revoke all on function public.superadmin_overview(), public.superadmin_review_access_request(uuid, public.access_request_status), public.superadmin_enqueue_operation(text,jsonb,text) from public, anon;
grant execute on function public.superadmin_overview(), public.superadmin_review_access_request(uuid, public.access_request_status), public.superadmin_enqueue_operation(text,jsonb,text) to authenticated, service_role;

commit;
