create table if not exists internal.vercel_webhook_subscriptions (
  connection_id uuid primary key references internal.integration_connections(id) on delete cascade,
  webhook_id text not null unique,
  owner_id text,
  team_id text,
  project_ids text[] not null default '{}',
  events text[] not null default '{}',
  vault_secret_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists internal.vercel_deployment_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references internal.integration_connections(id) on delete cascade,
  resource_id uuid references internal.integration_resources(id) on delete set null,
  event_id text not null,
  event_type text not null,
  project_id text,
  deployment_id text,
  deployment_url text,
  deployment_state text,
  deployment_target text,
  git_commit_sha text,
  git_branch text,
  error_code text,
  error_message text,
  event_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique(connection_id,event_id)
);

create index if not exists vercel_deployment_events_connection_created_idx
  on internal.vercel_deployment_events(connection_id,event_created_at desc);
create index if not exists vercel_deployment_events_deployment_idx
  on internal.vercel_deployment_events(connection_id,deployment_id)
  where deployment_id is not null;

create or replace function internal.delete_vercel_webhook_secret()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id=old.vault_secret_id;
  end if;
  return old;
end
$$;

drop trigger if exists delete_vercel_webhook_secret on internal.vercel_webhook_subscriptions;
create trigger delete_vercel_webhook_secret
before delete on internal.vercel_webhook_subscriptions
for each row execute function internal.delete_vercel_webhook_secret();

create or replace function internal.cleanup_vercel_webhook_on_disconnect()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.status='disconnected' and old.status is distinct from new.status then
    delete from internal.vercel_webhook_subscriptions where connection_id=new.id;
  end if;
  return new;
end
$$;

drop trigger if exists cleanup_vercel_webhook_on_disconnect on internal.integration_connections;
create trigger cleanup_vercel_webhook_on_disconnect
after update of status on internal.integration_connections
for each row execute function internal.cleanup_vercel_webhook_on_disconnect();

create or replace function public.service_upsert_vercel_webhook_subscription(
  target_connection_id uuid,
  target_webhook_id text,
  target_owner_id text,
  target_team_id text,
  target_project_ids text[],
  target_events text[],
  target_secret text
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  conn internal.integration_connections%rowtype;
  current_secret uuid;
  secret_id uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if nullif(trim(target_webhook_id),'') is null or nullif(target_secret,'') is null then
    raise exception 'vercel_webhook_credentials_required';
  end if;

  select * into conn
  from internal.integration_connections
  where id=target_connection_id and provider='vercel' and status in ('connected','active','ready')
  for update;
  if not found then raise exception 'vercel_connection_not_connected' using errcode='42501'; end if;

  select vault_secret_id into current_secret
  from internal.vercel_webhook_subscriptions
  where connection_id=target_connection_id
  for update;

  if current_secret is null then
    secret_id := vault.create_secret(target_secret,'vercel-webhook-'||target_connection_id::text,'Vercel webhook signing secret');
  else
    secret_id := current_secret;
    perform vault.update_secret(secret_id,target_secret,null,null,null);
  end if;

  insert into internal.vercel_webhook_subscriptions(
    connection_id,webhook_id,owner_id,team_id,project_ids,events,vault_secret_id,updated_at
  ) values (
    target_connection_id,left(trim(target_webhook_id),500),nullif(left(trim(coalesce(target_owner_id,'')),500),''),
    nullif(left(trim(coalesce(target_team_id,'')),500),''),coalesce(target_project_ids,'{}'::text[]),coalesce(target_events,'{}'::text[]),secret_id,now()
  )
  on conflict(connection_id) do update set
    webhook_id=excluded.webhook_id,
    owner_id=excluded.owner_id,
    team_id=excluded.team_id,
    project_ids=excluded.project_ids,
    events=excluded.events,
    vault_secret_id=excluded.vault_secret_id,
    updated_at=now();

  update internal.integration_connections
  set metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
    'webhook',jsonb_build_object(
      'status','active',
      'webhookId',left(trim(target_webhook_id),500),
      'projectCount',cardinality(coalesce(target_project_ids,'{}'::text[])),
      'events',to_jsonb(coalesce(target_events,'{}'::text[]))
    )
  ),
  last_error_code=null,
  last_synced_at=now()
  where id=target_connection_id;
end
$$;

create or replace function public.service_get_vercel_webhook_secret(target_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  sub internal.vercel_webhook_subscriptions%rowtype;
  secret_text text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  select s.* into sub
  from internal.vercel_webhook_subscriptions s
  join internal.integration_connections c on c.id=s.connection_id
  where s.connection_id=target_connection_id
    and c.provider='vercel'
    and c.status in ('connected','active','ready');
  if not found then raise exception 'vercel_webhook_not_found' using errcode='42501'; end if;
  select decrypted_secret into secret_text from vault.decrypted_secrets where id=sub.vault_secret_id;
  if secret_text is null then raise exception 'vercel_webhook_secret_missing' using errcode='42501'; end if;
  return jsonb_build_object(
    'connectionId',sub.connection_id,
    'webhookId',sub.webhook_id,
    'teamId',sub.team_id,
    'projectIds',to_jsonb(sub.project_ids),
    'events',to_jsonb(sub.events),
    'secret',secret_text
  );
end
$$;

create or replace function public.service_record_vercel_deployment_event(
  target_connection_id uuid,
  target_event_id text,
  target_event_type text,
  target_event_created_at timestamptz,
  target_project_id text,
  target_deployment_id text,
  target_deployment_url text,
  target_deployment_state text,
  target_deployment_target text,
  target_git_commit_sha text,
  target_git_branch text,
  target_error_code text,
  target_error_message text
)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  resource_id_value uuid;
  inserted_id uuid;
  latest internal.vercel_deployment_events%rowtype;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if nullif(trim(target_event_id),'') is null or nullif(trim(target_event_type),'') is null then
    raise exception 'vercel_event_identity_required';
  end if;

  select r.id into resource_id_value
  from internal.integration_resources r
  join internal.integration_connections c on c.id=r.connection_id
  where r.connection_id=target_connection_id
    and c.provider='vercel'
    and c.status in ('connected','active','ready')
    and r.resource_type='project'
    and r.external_id=target_project_id
  limit 1;
  if resource_id_value is null then raise exception 'vercel_project_not_authorized' using errcode='42501'; end if;

  insert into internal.vercel_deployment_events(
    connection_id,resource_id,event_id,event_type,project_id,deployment_id,deployment_url,deployment_state,
    deployment_target,git_commit_sha,git_branch,error_code,error_message,event_created_at
  ) values (
    target_connection_id,resource_id_value,left(trim(target_event_id),500),left(trim(target_event_type),160),
    left(trim(target_project_id),500),nullif(left(trim(coalesce(target_deployment_id,'')),500),''),
    nullif(left(trim(coalesce(target_deployment_url,'')),1000),''),nullif(left(trim(coalesce(target_deployment_state,'')),100),''),
    nullif(left(trim(coalesce(target_deployment_target,'')),100),''),nullif(left(trim(coalesce(target_git_commit_sha,'')),200),''),
    nullif(left(trim(coalesce(target_git_branch,'')),500),''),nullif(left(trim(coalesce(target_error_code,'')),240),''),
    nullif(left(trim(coalesce(target_error_message,'')),1000),''),coalesce(target_event_created_at,now())
  ) on conflict(connection_id,event_id) do nothing returning id into inserted_id;

  if inserted_id is null then return false; end if;

  select * into latest
  from internal.vercel_deployment_events
  where connection_id=target_connection_id and resource_id=resource_id_value
  order by event_created_at desc,received_at desc
  limit 1;

  update internal.integration_resources
  set metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
    'lastDeployment',jsonb_strip_nulls(jsonb_build_object(
      'eventType',latest.event_type,
      'deploymentId',latest.deployment_id,
      'url',latest.deployment_url,
      'state',latest.deployment_state,
      'target',latest.deployment_target,
      'gitCommitSha',latest.git_commit_sha,
      'gitBranch',latest.git_branch,
      'errorCode',latest.error_code,
      'errorMessage',latest.error_message,
      'createdAt',latest.event_created_at
    ))
  ),
  updated_at=now()
  where id=resource_id_value;

  update internal.integration_connections set last_synced_at=now() where id=target_connection_id;
  return true;
end
$$;

revoke all on function public.service_upsert_vercel_webhook_subscription(uuid,text,text,text,text[],text[],text) from public,anon,authenticated;
revoke all on function public.service_get_vercel_webhook_secret(uuid) from public,anon,authenticated;
revoke all on function public.service_record_vercel_deployment_event(uuid,text,text,timestamptz,text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.service_upsert_vercel_webhook_subscription(uuid,text,text,text,text[],text[],text) to service_role;
grant execute on function public.service_get_vercel_webhook_secret(uuid) to service_role;
grant execute on function public.service_record_vercel_deployment_event(uuid,text,text,timestamptz,text,text,text,text,text,text,text,text,text) to service_role;
