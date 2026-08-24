create or replace function internal.current_actor_trial_tokens_used(target_organization_id uuid, target_started_at timestamptz)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(coalesce(u.input_tokens,0) + coalesce(u.output_tokens,0)),0)::bigint
  from internal.usage_events u
  where u.organization_id = target_organization_id
    and u.occurred_at >= target_started_at
$$;

revoke all on function internal.current_actor_trial_tokens_used(uuid,timestamptz) from public, anon;
grant execute on function internal.current_actor_trial_tokens_used(uuid,timestamptz) to authenticated, service_role;
