begin;

create table if not exists internal.agent_run_intelligence (
  run_id uuid primary key references internal.agent_runs(id) on delete cascade,
  task_analysis jsonb not null default '{}'::jsonb,
  selected_skills jsonb not null default '[]'::jsonb check (jsonb_typeof(selected_skills) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists internal.agent_repository_indexes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references internal.agent_runs(id) on delete cascade,
  resource_id uuid not null references internal.integration_resources(id) on delete cascade,
  phase text not null check (phase in ('baseline','post_change')),
  verification_round integer check (verification_round is null or verification_round >= 0),
  repository text not null,
  ref text not null,
  revision_sha text not null check (revision_sha ~ '^[a-f0-9]{40}$'),
  content_revision_hash text not null check (content_revision_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'writing' check (status in ('writing','ready','partial','failed')),
  complete boolean not null default false,
  project_profile jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique nulls not distinct (run_id,resource_id,phase,verification_round,revision_sha)
);
create index if not exists agent_repository_indexes_run_created_idx on internal.agent_repository_indexes(run_id,created_at desc);
create index if not exists agent_repository_indexes_resource_revision_idx on internal.agent_repository_indexes(resource_id,revision_sha);

create table if not exists internal.agent_repository_index_nodes (
  index_id uuid not null references internal.agent_repository_indexes(id) on delete cascade,
  node_key text not null,
  kind text not null check (kind in ('file','symbol','route','database','test')),
  path text,
  label text not null,
  metadata jsonb not null default '{}'::jsonb,
  primary key(index_id,node_key)
);
create index if not exists agent_repository_index_nodes_path_idx on internal.agent_repository_index_nodes(index_id,path) where path is not null;

create table if not exists internal.agent_repository_index_edges (
  index_id uuid not null references internal.agent_repository_indexes(id) on delete cascade,
  from_key text not null,
  to_key text not null,
  kind text not null check (kind in ('imports','contains','routes_to','queries','tests','depends_on')),
  metadata jsonb not null default '{}'::jsonb,
  primary key(index_id,from_key,to_key,kind)
);

create table if not exists internal.agent_impact_analyses (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references internal.agent_runs(id) on delete cascade,
  verification_round integer not null check (verification_round >= 0),
  repository_index_id uuid references internal.agent_repository_indexes(id) on delete set null,
  risk text not null check (risk in ('low','medium','high','critical')),
  changed_count integer not null default 0 check (changed_count >= 0),
  affected_count integer not null default 0 check (affected_count >= 0),
  test_count integer not null default 0 check (test_count >= 0),
  verification_hints jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique(run_id,verification_round)
);
create index if not exists agent_impact_analyses_run_idx on internal.agent_impact_analyses(run_id,verification_round desc);

create table if not exists internal.agent_impact_nodes (
  analysis_id uuid not null references internal.agent_impact_analyses(id) on delete cascade,
  node_key text not null,
  kind text not null,
  path text,
  distance integer not null default 0 check (distance >= 0),
  direction text not null check (direction in ('changed','forward','reverse')),
  via text,
  primary key(analysis_id,node_key,direction)
);

create table if not exists internal.agent_verification_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references internal.agent_runs(id) on delete cascade,
  verification_round integer not null check (verification_round >= 0),
  repository_index_id uuid references internal.agent_repository_indexes(id) on delete set null,
  impact_analysis_id uuid references internal.agent_impact_analyses(id) on delete set null,
  status text not null check (status in ('passed','failed','blocked')),
  plan jsonb not null default '{}'::jsonb,
  blockers jsonb not null default '[]'::jsonb,
  reviewer jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(run_id,verification_round)
);
create index if not exists agent_verification_runs_created_idx on internal.agent_verification_runs(created_at desc);

create table if not exists internal.agent_verification_results (
  verification_run_id uuid not null references internal.agent_verification_runs(id) on delete cascade,
  check_kind text not null,
  required boolean not null,
  status text not null check (status in ('passed','failed','blocked','skipped')),
  summary text not null,
  evidence jsonb not null default '[]'::jsonb,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  primary key(verification_run_id,check_kind)
);

create table if not exists internal.agent_run_skill_observations (
  run_id uuid not null references internal.agent_runs(id) on delete cascade,
  skill_key text not null,
  activation_order integer not null check (activation_order > 0),
  status text not null default 'selected' check (status in ('selected','active','completed','failed')),
  created_at timestamptz not null default now(),
  primary key(run_id,skill_key),
  unique(run_id,activation_order)
);

alter table internal.agent_run_intelligence enable row level security;
alter table internal.agent_repository_indexes enable row level security;
alter table internal.agent_repository_index_nodes enable row level security;
alter table internal.agent_repository_index_edges enable row level security;
alter table internal.agent_impact_analyses enable row level security;
alter table internal.agent_impact_nodes enable row level security;
alter table internal.agent_verification_runs enable row level security;
alter table internal.agent_verification_results enable row level security;
alter table internal.agent_run_skill_observations enable row level security;

revoke all on table internal.agent_run_intelligence, internal.agent_repository_indexes, internal.agent_repository_index_nodes, internal.agent_repository_index_edges, internal.agent_impact_analyses, internal.agent_impact_nodes, internal.agent_verification_runs, internal.agent_verification_results, internal.agent_run_skill_observations from public,anon,authenticated;
grant all on table internal.agent_run_intelligence, internal.agent_repository_indexes, internal.agent_repository_index_nodes, internal.agent_repository_index_edges, internal.agent_impact_analyses, internal.agent_impact_nodes, internal.agent_verification_runs, internal.agent_verification_results, internal.agent_run_skill_observations to service_role;

create or replace function public.worker_record_run_intelligence(target_run_id uuid,target_task_analysis jsonb,target_skills jsonb)
returns void language plpgsql security definer set search_path=''
as $$
declare item jsonb; position integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if jsonb_typeof(coalesce(target_task_analysis,'{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(target_skills,'[]'::jsonb)) <> 'array' then raise exception 'invalid_agent_intelligence_payload'; end if;
  if not exists(select 1 from internal.agent_runs r where r.id=target_run_id) then raise exception 'agent_run_not_found'; end if;
  insert into internal.agent_run_intelligence(run_id,task_analysis,selected_skills,updated_at)
  values(target_run_id,coalesce(target_task_analysis,'{}'::jsonb),coalesce(target_skills,'[]'::jsonb),now())
  on conflict(run_id) do update set task_analysis=excluded.task_analysis,selected_skills=excluded.selected_skills,updated_at=now();
  delete from internal.agent_run_skill_observations where run_id=target_run_id;
  for item in select value from jsonb_array_elements(coalesce(target_skills,'[]'::jsonb)) loop
    position := position + 1;
    insert into internal.agent_run_skill_observations(run_id,skill_key,activation_order)
    values(target_run_id,left(coalesce(item->>'name',item#>>'{}'),160),position)
    on conflict(run_id,skill_key) do update set activation_order=excluded.activation_order,status='selected';
  end loop;
end $$;
revoke all on function public.worker_record_run_intelligence(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.worker_record_run_intelligence(uuid,jsonb,jsonb) to service_role;

create or replace function public.worker_begin_repository_index(target_run_id uuid,target_resource_id uuid,target_phase text,target_verification_round integer,target_repository text,target_ref text,target_revision_sha text,target_content_revision_hash text,target_project_profile jsonb)
returns uuid language plpgsql security definer set search_path=''
as $$ declare result_id uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if target_phase not in ('baseline','post_change') then raise exception 'invalid_repository_index_phase'; end if;
  if target_revision_sha !~ '^[a-f0-9]{40}$' or target_content_revision_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_repository_revision'; end if;
  insert into internal.agent_repository_indexes(run_id,resource_id,phase,verification_round,repository,ref,revision_sha,content_revision_hash,status,complete,project_profile,counts,finished_at)
  values(target_run_id,target_resource_id,target_phase,target_verification_round,left(target_repository,500),left(target_ref,500),target_revision_sha,target_content_revision_hash,'writing',false,coalesce(target_project_profile,'{}'::jsonb),'{}'::jsonb,null)
  on conflict(run_id,resource_id,phase,verification_round,revision_sha) do update set repository=excluded.repository,ref=excluded.ref,content_revision_hash=excluded.content_revision_hash,status='writing',complete=false,project_profile=excluded.project_profile,counts='{}'::jsonb,finished_at=null
  returning id into result_id;
  delete from internal.agent_repository_index_nodes where index_id=result_id;
  delete from internal.agent_repository_index_edges where index_id=result_id;
  return result_id;
end $$;
revoke all on function public.worker_begin_repository_index(uuid,uuid,text,integer,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.worker_begin_repository_index(uuid,uuid,text,integer,text,text,text,text,jsonb) to service_role;

create or replace function public.worker_append_repository_index(target_index_id uuid,target_nodes jsonb default '[]'::jsonb,target_edges jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$ declare node_count integer := 0; edge_count integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if jsonb_typeof(coalesce(target_nodes,'[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(target_edges,'[]'::jsonb)) <> 'array' then raise exception 'invalid_repository_index_batch'; end if;
  if not exists(select 1 from internal.agent_repository_indexes i where i.id=target_index_id and i.status='writing') then raise exception 'repository_index_not_writable'; end if;
  insert into internal.agent_repository_index_nodes(index_id,node_key,kind,path,label,metadata)
  select target_index_id,left(x.node_key,1200),x.kind,nullif(left(coalesce(x.path,''),2000),''),left(x.label,2000),coalesce(x.metadata,'{}'::jsonb)
  from jsonb_to_recordset(coalesce(target_nodes,'[]'::jsonb)) as x(node_key text,kind text,path text,label text,metadata jsonb)
  where x.node_key is not null and x.label is not null and x.kind in ('file','symbol','route','database','test')
  on conflict(index_id,node_key) do update set kind=excluded.kind,path=excluded.path,label=excluded.label,metadata=excluded.metadata;
  get diagnostics node_count = row_count;
  insert into internal.agent_repository_index_edges(index_id,from_key,to_key,kind,metadata)
  select target_index_id,left(x.from_key,1200),left(x.to_key,1200),x.kind,coalesce(x.metadata,'{}'::jsonb)
  from jsonb_to_recordset(coalesce(target_edges,'[]'::jsonb)) as x(from_key text,to_key text,kind text,metadata jsonb)
  where x.from_key is not null and x.to_key is not null and x.kind in ('imports','contains','routes_to','queries','tests','depends_on')
  on conflict(index_id,from_key,to_key,kind) do update set metadata=excluded.metadata;
  get diagnostics edge_count = row_count;
  return jsonb_build_object('nodes',node_count,'edges',edge_count);
end $$;
revoke all on function public.worker_append_repository_index(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.worker_append_repository_index(uuid,jsonb,jsonb) to service_role;

create or replace function public.worker_finish_repository_index(target_index_id uuid,target_complete boolean,target_counts jsonb)
returns uuid language plpgsql security definer set search_path=''
as $$ begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  update internal.agent_repository_indexes set status=case when target_complete then 'ready' else 'partial' end,complete=target_complete,counts=coalesce(target_counts,'{}'::jsonb),finished_at=now() where id=target_index_id and status='writing';
  if not found then raise exception 'repository_index_not_writable'; end if;
  return target_index_id;
end $$;
revoke all on function public.worker_finish_repository_index(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.worker_finish_repository_index(uuid,boolean,jsonb) to service_role;

create or replace function public.worker_record_impact_analysis(target_run_id uuid,target_verification_round integer,target_repository_index_id uuid,target_risk text,target_verification_hints jsonb,target_nodes jsonb)
returns uuid language plpgsql security definer set search_path=''
as $$ declare result_id uuid; changed_total integer; affected_total integer; test_total integer;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if target_risk not in ('low','medium','high','critical') or target_verification_round < 0 then raise exception 'invalid_impact_analysis'; end if;
  select count(*) filter(where coalesce(x.direction,'')='changed'),count(*),count(*) filter(where coalesce(x.kind,'')='test') into changed_total,affected_total,test_total from jsonb_to_recordset(coalesce(target_nodes,'[]'::jsonb)) as x(kind text,direction text);
  insert into internal.agent_impact_analyses(run_id,verification_round,repository_index_id,risk,changed_count,affected_count,test_count,verification_hints)
  values(target_run_id,target_verification_round,target_repository_index_id,target_risk,coalesce(changed_total,0),coalesce(affected_total,0),coalesce(test_total,0),coalesce(target_verification_hints,'[]'::jsonb))
  on conflict(run_id,verification_round) do update set repository_index_id=excluded.repository_index_id,risk=excluded.risk,changed_count=excluded.changed_count,affected_count=excluded.affected_count,test_count=excluded.test_count,verification_hints=excluded.verification_hints
  returning id into result_id;
  delete from internal.agent_impact_nodes where analysis_id=result_id;
  insert into internal.agent_impact_nodes(analysis_id,node_key,kind,path,distance,direction,via)
  select result_id,left(x.node_key,1200),left(coalesce(x.kind,'unknown'),80),nullif(left(coalesce(x.path,''),2000),''),greatest(coalesce(x.distance,0),0),x.direction,nullif(left(coalesce(x.via,''),1200),'')
  from jsonb_to_recordset(coalesce(target_nodes,'[]'::jsonb)) as x(node_key text,kind text,path text,distance integer,direction text,via text)
  where x.node_key is not null and x.direction in ('changed','forward','reverse')
  on conflict(analysis_id,node_key,direction) do update set kind=excluded.kind,path=excluded.path,distance=excluded.distance,via=excluded.via;
  return result_id;
end $$;
revoke all on function public.worker_record_impact_analysis(uuid,integer,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.worker_record_impact_analysis(uuid,integer,uuid,text,jsonb,jsonb) to service_role;

create or replace function public.worker_record_verification_run(target_run_id uuid,target_verification_round integer,target_repository_index_id uuid,target_impact_analysis_id uuid,target_status text,target_plan jsonb,target_blockers jsonb,target_reviewer jsonb,target_results jsonb)
returns uuid language plpgsql security definer set search_path=''
as $$ declare result_id uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if target_status not in ('passed','failed','blocked') or target_verification_round < 0 then raise exception 'invalid_verification_run'; end if;
  insert into internal.agent_verification_runs(run_id,verification_round,repository_index_id,impact_analysis_id,status,plan,blockers,reviewer)
  values(target_run_id,target_verification_round,target_repository_index_id,target_impact_analysis_id,target_status,coalesce(target_plan,'{}'::jsonb),coalesce(target_blockers,'[]'::jsonb),coalesce(target_reviewer,'{}'::jsonb))
  on conflict(run_id,verification_round) do update set repository_index_id=excluded.repository_index_id,impact_analysis_id=excluded.impact_analysis_id,status=excluded.status,plan=excluded.plan,blockers=excluded.blockers,reviewer=excluded.reviewer,created_at=now()
  returning id into result_id;
  delete from internal.agent_verification_results where verification_run_id=result_id;
  insert into internal.agent_verification_results(verification_run_id,check_kind,required,status,summary,evidence,duration_ms)
  select result_id,left(x.check_kind,160),coalesce(x.required,false),x.status,left(coalesce(x.summary,''),4000),coalesce(x.evidence,'[]'::jsonb),case when x.duration_ms is null then null else greatest(x.duration_ms,0) end
  from jsonb_to_recordset(coalesce(target_results,'[]'::jsonb)) as x(check_kind text,required boolean,status text,summary text,evidence jsonb,duration_ms integer)
  where x.check_kind is not null and x.status in ('passed','failed','blocked','skipped')
  on conflict(verification_run_id,check_kind) do update set required=excluded.required,status=excluded.status,summary=excluded.summary,evidence=excluded.evidence,duration_ms=excluded.duration_ms;
  return result_id;
end $$;
revoke all on function public.worker_record_verification_run(uuid,integer,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.worker_record_verification_run(uuid,integer,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) to service_role;

create or replace function public.superadmin_agent_platform_snapshot()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not internal.is_superadmin_email_verified() then raise exception 'superadmin_step_up_required' using errcode='42501'; end if;
  return jsonb_build_object(
    'counts',jsonb_build_object(
      'repository_indexes',(select count(*) from internal.agent_repository_indexes),
      'verification_runs',(select count(*) from internal.agent_verification_runs),
      'verification_passed',(select count(*) from internal.agent_verification_runs where status='passed'),
      'impact_analyses',(select count(*) from internal.agent_impact_analyses),
      'tracked_runs',(select count(*) from internal.agent_run_intelligence)
    ),
    'repository_indexes',coalesce((select jsonb_agg(to_jsonb(x)) from (select i.id,i.run_id,i.phase,i.verification_round,i.repository,i.ref,i.revision_sha,i.status,i.complete,i.counts,i.project_profile,i.created_at,i.finished_at from internal.agent_repository_indexes i order by i.created_at desc limit 20) x),'[]'::jsonb),
    'impacts',coalesce((select jsonb_agg(to_jsonb(x)) from (select a.id,a.run_id,a.verification_round,a.risk,a.changed_count,a.affected_count,a.test_count,a.created_at from internal.agent_impact_analyses a order by a.created_at desc limit 20) x),'[]'::jsonb),
    'verifications',coalesce((select jsonb_agg(to_jsonb(x)) from (select v.id,v.run_id,v.verification_round,v.status,v.blockers,v.reviewer,v.created_at,i.revision_sha,i.ref from internal.agent_verification_runs v left join internal.agent_repository_indexes i on i.id=v.repository_index_id order by v.created_at desc limit 30) x),'[]'::jsonb),
    'skills',coalesce((select jsonb_agg(to_jsonb(x)) from (select s.run_id,s.skill_key,s.activation_order,s.status,s.created_at from internal.agent_run_skill_observations s order by s.created_at desc,s.activation_order asc limit 50) x),'[]'::jsonb)
  );
end $$;
revoke all on function public.superadmin_agent_platform_snapshot() from public,anon;
grant execute on function public.superadmin_agent_platform_snapshot() to authenticated;

create or replace function public.superadmin_agent_run_trace(target_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not internal.is_superadmin_email_verified() then raise exception 'superadmin_step_up_required' using errcode='42501'; end if;
  if not exists(select 1 from internal.agent_runs where id=target_run_id) then raise exception 'agent_run_not_found'; end if;
  return jsonb_build_object(
    'run',(select to_jsonb(x) from (select r.id,r.mode,r.status,r.model_alias,r.failure_code,r.created_at,r.started_at,r.finished_at,r.updated_at from internal.agent_runs r where r.id=target_run_id) x),
    'intelligence',(select to_jsonb(x) from (select i.task_analysis,i.selected_skills,i.created_at,i.updated_at from internal.agent_run_intelligence i where i.run_id=target_run_id) x),
    'indexes',coalesce((select jsonb_agg(to_jsonb(x)) from (select i.id,i.phase,i.verification_round,i.repository,i.ref,i.revision_sha,i.content_revision_hash,i.status,i.complete,i.project_profile,i.counts,i.created_at,i.finished_at,(select count(*) from internal.agent_repository_index_nodes n where n.index_id=i.id) node_count,(select count(*) from internal.agent_repository_index_edges e where e.index_id=i.id) edge_count from internal.agent_repository_indexes i where i.run_id=target_run_id order by i.created_at) x),'[]'::jsonb),
    'impacts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'verification_round',a.verification_round,'risk',a.risk,'changed_count',a.changed_count,'affected_count',a.affected_count,'test_count',a.test_count,'verification_hints',a.verification_hints,'nodes',coalesce((select jsonb_agg(to_jsonb(n)) from internal.agent_impact_nodes n where n.analysis_id=a.id),'[]'::jsonb),'created_at',a.created_at) order by a.verification_round) from internal.agent_impact_analyses a where a.run_id=target_run_id),'[]'::jsonb),
    'verifications',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'verification_round',v.verification_round,'status',v.status,'plan',v.plan,'blockers',v.blockers,'reviewer',v.reviewer,'results',coalesce((select jsonb_agg(to_jsonb(r) order by r.check_kind) from internal.agent_verification_results r where r.verification_run_id=v.id),'[]'::jsonb),'created_at',v.created_at) order by v.verification_round) from internal.agent_verification_runs v where v.run_id=target_run_id),'[]'::jsonb),
    'skills',coalesce((select jsonb_agg(to_jsonb(x)) from (select s.skill_key,s.activation_order,s.status,s.created_at from internal.agent_run_skill_observations s where s.run_id=target_run_id order by s.activation_order) x),'[]'::jsonb)
  );
end $$;
revoke all on function public.superadmin_agent_run_trace(uuid) from public,anon;
grant execute on function public.superadmin_agent_run_trace(uuid) to authenticated;

commit;
