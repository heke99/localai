do $$
declare
  lease_one boolean;
  lease_two boolean;
  lease_same boolean;
  released_wrong boolean;
  released_right boolean;
begin
  -- Use the existing seeded production alias/provider. These calls run as the
  -- migration-test service role in the database consistency workflow.
  select public.runtime_acquire_provisioning_lease('general-prod', 'runpod', 'test-holder-one', 60)
    into lease_one;
  select public.runtime_acquire_provisioning_lease('general-prod', 'runpod', 'test-holder-two', 60)
    into lease_two;
  select public.runtime_acquire_provisioning_lease('general-prod', 'runpod', 'test-holder-one', 60)
    into lease_same;

  if lease_one is not true or lease_two is not false or lease_same is not true then
    raise exception 'runtime provisioning lease does not serialize holders correctly';
  end if;

  select public.runtime_release_provisioning_lease('general-prod', 'runpod', 'test-holder-two')
    into released_wrong;
  select public.runtime_release_provisioning_lease('general-prod', 'runpod', 'test-holder-one')
    into released_right;

  if released_wrong is not false or released_right is not true then
    raise exception 'runtime provisioning lease release ownership is broken';
  end if;

  if exists (
    select 1 from internal.runtime_provisioning_leases
    where alias = 'general-prod' and provider_key = 'runpod'
  ) then
    raise exception 'runtime provisioning lease test left stale state';
  end if;
end $$;
