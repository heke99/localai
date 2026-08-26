begin;

create table if not exists internal.runtime_bootstrap_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  provider_key text not null references internal.gpu_providers(key),
  model_alias text not null references internal.model_aliases(alias) on delete cascade,
  external_worker_id text not null check (char_length(external_worker_id) between 1 and 512),
  profile text not null check (char_length(profile) between 1 and 160),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists runtime_bootstrap_tokens_active_idx
  on internal.runtime_bootstrap_tokens (expires_at)
  where consumed_at is null;

revoke all on table internal.runtime_bootstrap_tokens from public, anon, authenticated;
grant select, insert, update, delete on table internal.runtime_bootstrap_tokens to service_role;

create or replace function public.runtime_create_bootstrap_token_hash(
  target_token_hash text,
  target_provider_key text,
  target_model_alias text,
  target_external_worker_id text,
  target_profile text,
  target_ttl_seconds integer default 900
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if target_token_hash is null or target_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_runtime_bootstrap_hash';
  end if;
  if target_provider_key is null or target_provider_key !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid_runtime_provider_key';
  end if;
  if target_model_alias is null or char_length(target_model_alias) not between 1 and 160 then
    raise exception 'invalid_runtime_alias';
  end if;
  if target_external_worker_id is null or char_length(target_external_worker_id) not between 1 and 512 then
    raise exception 'invalid_runtime_external_id';
  end if;
  if target_profile is null or char_length(target_profile) not between 1 and 160 then
    raise exception 'invalid_runtime_profile';
  end if;
  if target_ttl_seconds is null or target_ttl_seconds not between 60 and 3600 then
    raise exception 'invalid_runtime_bootstrap_ttl';
  end if;
  if not exists (
    select 1 from internal.gpu_providers p
    where p.key = target_provider_key and p.enabled
  ) then
    raise exception 'runtime_provider_disabled';
  end if;
  if not exists (
    select 1 from internal.model_aliases a
    where a.alias = target_model_alias
  ) then
    raise exception 'runtime_model_alias_not_found';
  end if;

  delete from internal.runtime_bootstrap_tokens
  where expires_at < now() - interval '1 day';

  insert into internal.runtime_bootstrap_tokens (
    token_hash,
    provider_key,
    model_alias,
    external_worker_id,
    profile,
    expires_at
  ) values (
    target_token_hash,
    target_provider_key,
    target_model_alias,
    target_external_worker_id,
    target_profile,
    now() + make_interval(secs => target_ttl_seconds)
  )
  returning id into created_id;

  return created_id;
end;
$$;

create or replace function public.runtime_consume_bootstrap_token(target_token_hash text)
returns table (
  provider_key text,
  model_alias text,
  external_worker_id text,
  profile text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if target_token_hash is null or target_token_hash !~ '^[a-f0-9]{64}$' then
    return;
  end if;

  select b.id
  into target_id
  from internal.runtime_bootstrap_tokens b
  where b.token_hash = target_token_hash
    and b.consumed_at is null
    and b.expires_at > now()
  for update skip locked;

  if target_id is null then
    return;
  end if;

  update internal.runtime_bootstrap_tokens
  set consumed_at = now()
  where id = target_id;

  return query
  select b.provider_key, b.model_alias, b.external_worker_id, b.profile
  from internal.runtime_bootstrap_tokens b
  where b.id = target_id;
end;
$$;

revoke all on function public.runtime_create_bootstrap_token_hash(text,text,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.runtime_consume_bootstrap_token(text) from public, anon, authenticated;
grant execute on function public.runtime_create_bootstrap_token_hash(text,text,text,text,text,integer) to service_role;
grant execute on function public.runtime_consume_bootstrap_token(text) to service_role;

commit;
