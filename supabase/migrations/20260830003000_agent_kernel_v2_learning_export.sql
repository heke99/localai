begin;

create or replace function public.worker_export_verified_agent_learning(
  target_min_reward integer default 1,
  target_limit integer default 500,
  target_created_before timestamptz default now()
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  result jsonb;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if coalesce(target_min_reward,0) < 1 or coalesce(target_min_reward,0) > 1000 then
    raise exception 'invalid_learning_export_min_reward';
  end if;
  if coalesce(target_limit,0) < 1 or target_limit > 5000 then
    raise exception 'invalid_learning_export_limit';
  end if;
  if target_created_before is null then
    raise exception 'learning_export_cutoff_required';
  end if;

  select jsonb_build_object(
    'schemaVersion', 1,
    'queryVersion', 'verified-learning-v1',
    'createdBefore', target_created_before,
    'minReward', target_min_reward,
    'records', coalesce(jsonb_agg(to_jsonb(x) order by x.created_at asc, x.trajectory_id asc), '[]'::jsonb)
  )
  into result
  from (
    select
      t.trajectory_id as "trajectoryId",
      t.model_version as "modelVersion",
      t.prompt_version as "promptVersion",
      t.steps,
      t.user_feedback as "userFeedback",
      t.reward,
      t.created_at as "createdAt",
      t.created_at
    from internal.agent_trajectories t
    where t.training_eligible
      and t.reward >= target_min_reward
      and t.created_at <= target_created_before
      and jsonb_array_length(t.steps) > 0
      and not exists (
        select 1
        from jsonb_array_elements(t.steps) step
        where coalesce(step->>'verificationResult','') = 'failed'
      )
      and exists (
        select 1
        from jsonb_array_elements(t.steps) step
        where coalesce(step->>'verificationResult','') = 'passed'
      )
    order by t.created_at asc, t.trajectory_id asc
    limit target_limit
  ) x;

  return result;
end $$;

revoke all on function public.worker_export_verified_agent_learning(integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.worker_export_verified_agent_learning(integer,integer,timestamptz) to service_role;

commit;
