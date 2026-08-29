begin;

create table if not exists internal.agent_kernel_checkpoints (
  checkpoint_id text primary key check (checkpoint_id ~ '^[a-f0-9]{64}$'),
  run_id uuid not null references internal.agent_runs(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 240),
  snapshots jsonb not null default '[]'::jsonb check (jsonb_typeof(snapshots) = 'array'),
  plan_digest text check (plan_digest is null or plan_digest ~ '^[a-f0-9]{64}$'),
  verification jsonb,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists agent_kernel_checkpoints_run_created_idx on internal.agent_kernel_checkpoints(run_id,created_at desc);
create index if not exists agent_kernel_checkpoints_run_verified_idx on internal.agent_kernel_checkpoints(run_id,created_at desc) where verified;

create table if not exists internal.agent_memory_records (
  memory_id text primary key check (memory_id ~ '^[a-f0-9]{64}$'),
  source_run_id uuid not null references internal.agent_runs(id) on delete cascade,
  tier text not null check (tier in ('working','episodic','semantic','procedural','verified_experience')),
  scope text not null check (char_length(scope) between 1 and 300),
  summary text not null check (char_length(summary) between 1 and 12000),
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs) = 'array'),
  verified boolean not null default false,
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tier <> 'verified_experience' or (verified and jsonb_array_length(evidence_refs) > 0 and confidence >= 0.5))
);
create index if not exists agent_memory_records_scope_tier_idx on internal.agent_memory_records(scope,tier,updated_at desc);
create index if not exists agent_memory_records_verified_idx on internal.agent_memory_records(scope,updated_at desc) where verified;

create table if not exists internal.agent_trajectories (
  trajectory_id text primary key check (trajectory_id ~ '^[a-f0-9]{64}$'),
  run_id uuid not null references internal.agent_runs(id) on delete cascade,
  model_version text not null check (char_length(model_version) between 1 and 300),
  prompt_version text not null check (char_length(prompt_version) between 1 and 300),
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  user_feedback text not null default 'unknown' check (user_feedback in ('accepted','rejected','unknown')),
  reward integer not null default 0 check (reward between -1000 and 1000),
  training_eligible boolean not null default false,
  created_at timestamptz not null default now(),
  check (not training_eligible or reward > 0)
);
create index if not exists agent_trajectories_run_created_idx on internal.agent_trajectories(run_id,created_at desc);
create index if not exists agent_trajectories_training_idx on internal.agent_trajectories(reward desc,created_at desc) where training_eligible;

alter table internal.agent_kernel_checkpoints enable row level security;
alter table internal.agent_memory_records enable row level security;
alter table internal.agent_trajectories enable row level security;

revoke all on table internal.agent_kernel_checkpoints, internal.agent_memory_records, internal.agent_trajectories from public,anon,authenticated;
grant all on table internal.agent_kernel_checkpoints, internal.agent_memory_records, internal.agent_trajectories to service_role;

create or replace function public.worker_record_agent_kernel_checkpoint(
  target_checkpoint_id text,
  target_run_id uuid,
  target_label text,
  target_snapshots jsonb,
  target_plan_digest text,
  target_verification jsonb,
  target_verified boolean
) returns void language plpgsql security definer set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if target_checkpoint_id !~ '^[a-f0-9]{64}$' or char_length(trim(coalesce(target_label,''))) not between 1 and 240 then raise exception 'invalid_agent_kernel_checkpoint'; end if;
  if jsonb_typeof(coalesce(target_snapshots,'[]'::jsonb)) <> 'array' then raise exception 'invalid_agent_kernel_snapshots'; end if;
  if target_plan_digest is not null and target_plan_digest !~ '^[a-f0-9]{64}$' then raise exception 'invalid_agent_kernel_plan_digest'; end if;
  if target_verified and target_verification is null then raise exception 'verified_checkpoint_requires_verification'; end if;
  insert into internal.agent_kernel_checkpoints(checkpoint_id,run_id,label,snapshots,plan_digest,verification,verified)
  values(target_checkpoint_id,target_run_id,left(trim(target_label),240),coalesce(target_snapshots,'[]'::jsonb),target_plan_digest,target_verification,coalesce(target_verified,false))
  on conflict(checkpoint_id) do update set label=excluded.label,snapshots=excluded.snapshots,plan_digest=excluded.plan_digest,verification=excluded.verification,verified=excluded.verified;
end $$;
revoke all on function public.worker_record_agent_kernel_checkpoint(text,uuid,text,jsonb,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.worker_record_agent_kernel_checkpoint(text,uuid,text,jsonb,text,jsonb,boolean) to service_role;

create or replace function public.worker_latest_verified_agent_kernel_checkpoint(target_run_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  select case
    when coalesce(auth.jwt()->>'role','') <> 'service_role' then null
    else (
      select jsonb_build_object(
        'checkpointId',c.checkpoint_id,
        'runId',c.run_id,
        'label',c.label,
        'snapshots',c.snapshots,
        'planDigest',c.plan_digest,
        'verification',c.verification,
        'verified',c.verified,
        'createdAt',c.created_at
      )
      from internal.agent_kernel_checkpoints c
      where c.run_id=target_run_id and c.verified
      order by c.created_at desc
      limit 1
    )
  end
$$;
revoke all on function public.worker_latest_verified_agent_kernel_checkpoint(uuid) from public,anon,authenticated;
grant execute on function public.worker_latest_verified_agent_kernel_checkpoint(uuid) to service_role;

create or replace function public.worker_upsert_agent_memory(
  target_memory_id text,
  target_source_run_id uuid,
  target_tier text,
  target_scope text,
  target_summary text,
  target_evidence_refs jsonb,
  target_verified boolean,
  target_confidence numeric
) returns void language plpgsql security definer set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if target_memory_id !~ '^[a-f0-9]{64}$' or target_tier not in ('working','episodic','semantic','procedural','verified_experience') then raise exception 'invalid_agent_memory'; end if;
  if char_length(trim(coalesce(target_scope,''))) not between 1 and 300 or char_length(trim(coalesce(target_summary,''))) not between 1 and 12000 then raise exception 'invalid_agent_memory_text'; end if;
  if jsonb_typeof(coalesce(target_evidence_refs,'[]'::jsonb)) <> 'array' or coalesce(target_confidence,-1) < 0 or target_confidence > 1 then raise exception 'invalid_agent_memory_evidence'; end if;
  if target_tier='verified_experience' and (not coalesce(target_verified,false) or jsonb_array_length(coalesce(target_evidence_refs,'[]'::jsonb))=0 or target_confidence < 0.5) then raise exception 'verified_experience_requires_evidence'; end if;
  insert into internal.agent_memory_records(memory_id,source_run_id,tier,scope,summary,evidence_refs,verified,confidence,updated_at)
  values(target_memory_id,target_source_run_id,target_tier,left(trim(target_scope),300),left(trim(target_summary),12000),coalesce(target_evidence_refs,'[]'::jsonb),coalesce(target_verified,false),target_confidence,now())
  on conflict(memory_id) do update set scope=excluded.scope,summary=excluded.summary,evidence_refs=excluded.evidence_refs,verified=excluded.verified,confidence=excluded.confidence,updated_at=now();
end $$;
revoke all on function public.worker_upsert_agent_memory(text,uuid,text,text,text,jsonb,boolean,numeric) from public,anon,authenticated;
grant execute on function public.worker_upsert_agent_memory(text,uuid,text,text,text,jsonb,boolean,numeric) to service_role;

create or replace function public.worker_find_agent_memories(target_scope text,target_limit integer default 12)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if char_length(trim(coalesce(target_scope,''))) not between 1 and 300 then raise exception 'invalid_agent_memory_scope'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.rank asc,x.updated_at desc)
    from (
      select m.memory_id as "id",m.tier,m.scope,m.summary,m.evidence_refs as "evidenceRefs",m.source_run_id as "sourceRunId",m.created_at as "createdAt",m.updated_at,m.verified,m.confidence,
        case m.tier when 'verified_experience' then 0 when 'procedural' then 1 when 'semantic' then 2 when 'episodic' then 3 else 4 end rank
      from internal.agent_memory_records m
      where m.scope=trim(target_scope)
        and (m.tier not in ('verified_experience','procedural') or m.verified)
        and (m.tier <> 'verified_experience' or (jsonb_array_length(m.evidence_refs)>0 and m.confidence>=0.5))
      order by rank asc,m.updated_at desc
      limit least(greatest(coalesce(target_limit,12),1),50)
    ) x
  ),'[]'::jsonb);
end $$;
revoke all on function public.worker_find_agent_memories(text,integer) from public,anon,authenticated;
grant execute on function public.worker_find_agent_memories(text,integer) to service_role;

create or replace function public.worker_record_agent_trajectory(
  target_trajectory_id text,
  target_run_id uuid,
  target_model_version text,
  target_prompt_version text,
  target_steps jsonb,
  target_user_feedback text,
  target_reward integer,
  target_training_eligible boolean
) returns void language plpgsql security definer set search_path=''
as $$
declare failed_steps integer := 0; passed_steps integer := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if target_trajectory_id !~ '^[a-f0-9]{64}$' or char_length(trim(coalesce(target_model_version,''))) not between 1 and 300 or char_length(trim(coalesce(target_prompt_version,''))) not between 1 and 300 then raise exception 'invalid_agent_trajectory'; end if;
  if jsonb_typeof(coalesce(target_steps,'[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(target_steps,'[]'::jsonb))=0 then raise exception 'agent_trajectory_steps_required'; end if;
  if target_user_feedback not in ('accepted','rejected','unknown') or target_reward not between -1000 and 1000 then raise exception 'invalid_agent_trajectory_outcome'; end if;
  select count(*) filter(where coalesce(x->>'verificationResult','')='failed'),count(*) filter(where coalesce(x->>'verificationResult','')='passed') into failed_steps,passed_steps from jsonb_array_elements(target_steps) x;
  if target_training_eligible and (target_reward<=0 or failed_steps>0 or passed_steps=0) then raise exception 'trajectory_not_training_eligible'; end if;
  insert into internal.agent_trajectories(trajectory_id,run_id,model_version,prompt_version,steps,user_feedback,reward,training_eligible)
  values(target_trajectory_id,target_run_id,left(trim(target_model_version),300),left(trim(target_prompt_version),300),target_steps,target_user_feedback,target_reward,coalesce(target_training_eligible,false))
  on conflict(trajectory_id) do update set steps=excluded.steps,user_feedback=excluded.user_feedback,reward=excluded.reward,training_eligible=excluded.training_eligible;
end $$;
revoke all on function public.worker_record_agent_trajectory(text,uuid,text,text,jsonb,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.worker_record_agent_trajectory(text,uuid,text,text,jsonb,text,integer,boolean) to service_role;

commit;
