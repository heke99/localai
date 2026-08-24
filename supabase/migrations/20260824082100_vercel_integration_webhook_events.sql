create table if not exists internal.vercel_webhook_events (
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
  metadata_redacted jsonb not null default '{}'::jsonb,
  event_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique(connection_id,event_id)
);

create index if not exists vercel_webhook_events_connection_created_idx
  on internal.vercel_webhook_events(connection_id,event_created_at desc);
create index if not exists vercel_webhook_events_deployment_idx
  on internal.vercel_webhook_events(connection_id,deployment_id)
  where deployment_id is not null;
create index if not exists vercel_webhook_events_project_idx
  on internal.vercel_webhook_events(connection_id,project_id,event_created_at desc)
  where project_id is not null;

create or replace function public.service_find_vercel_connections_for_webhook(
  target_configuration_id text,
  target_project_id text,
  target_team_id text
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'connectionId',q.id,
    'organizationId',q.organization_id,
    'metadata',q.metadata
  ) order by q.created_at desc),'[]'::jsonb)
  from (
    select distinct c.id,c.organization_id,c.metadata,c.created_at
    from internal.integration_connections c
    left join internal.integration_resources r
      on r.connection_id=c.id
     and r.resource_type='project'
    where c.provider='vercel'
      and c.status in ('connected','active','ready')
      and (
        (
          nullif(trim(coalesce(target_configuration_id,'')),'') is not null
          and c.metadata->>'callbackConfigurationId'=trim(target_configuration_id)
        )
        or (
          nullif(trim(coalesce(target_project_id,'')),'') is not null
          and r.external_id=trim(target_project_id)
          and (
            nullif(trim(coalesce(target_team_id,'')),'') is null
            or c.metadata->>'callbackTeamId'=trim(target_team_id)
          )
        )
      )
  ) q
  where coalesce(auth.jwt()->>'role','')='service_role'
$$;

create or replace function public.service_record_vercel_webhook_event(
  target_connection_id uuid,
  target_event_id text,
  target_event_type text,
  target_event_created_at timestamptz,
  target_project_id text,
  target_deployment_id text,
  target_deployment_url text,
  target_deployment_state text,
  target_deployment_target text,
  target_metadata jsonb
)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  conn internal.integration_connections%rowtype;
  resource_id_value uuid;
  inserted_id uuid;
  safe_metadata jsonb := coalesce(target_metadata,'{}'::jsonb);
  event_snapshot jsonb;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  if nullif(trim(target_event_id),'') is null or nullif(trim(target_event_type),'') is null then
    raise exception 'vercel_event_identity_required';
  end if;
  if octet_length(safe_metadata::text) > 32768 then
    raise exception 'vercel_event_metadata_too_large';
  end if;

  select * into conn
  from internal.integration_connections
  where id=target_connection_id and provider='vercel' and status in ('connected','active','ready')
  for update;
  if not found then raise exception 'vercel_connection_not_connected' using errcode='42501'; end if;

  if nullif(trim(coalesce(target_project_id,'')),'') is not null then
    select r.id into resource_id_value
    from internal.integration_resources r
    where r.connection_id=target_connection_id
      and r.resource_type='project'
      and r.external_id=trim(target_project_id)
    limit 1;
  end if;

  if target_event_type like 'deployment.%' and resource_id_value is null then
    raise exception 'vercel_project_not_authorized' using errcode='42501';
  end if;

  insert into internal.vercel_webhook_events(
    connection_id,resource_id,event_id,event_type,project_id,deployment_id,deployment_url,
    deployment_state,deployment_target,metadata_redacted,event_created_at
  ) values (
    target_connection_id,resource_id_value,left(trim(target_event_id),500),left(trim(target_event_type),160),
    nullif(left(trim(coalesce(target_project_id,'')),500),''),
    nullif(left(trim(coalesce(target_deployment_id,'')),500),''),
    nullif(left(trim(coalesce(target_deployment_url,'')),1000),''),
    nullif(left(trim(coalesce(target_deployment_state,'')),100),''),
    nullif(left(trim(coalesce(target_deployment_target,'')),100),''),
    safe_metadata,coalesce(target_event_created_at,now())
  ) on conflict(connection_id,event_id) do nothing returning id into inserted_id;

  if inserted_id is null then return false; end if;

  event_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'eventType',left(trim(target_event_type),160),
    'projectId',nullif(left(trim(coalesce(target_project_id,'')),500),''),
    'deploymentId',nullif(left(trim(coalesce(target_deployment_id,'')),500),''),
    'url',nullif(left(trim(coalesce(target_deployment_url,'')),1000),''),
    'state',nullif(left(trim(coalesce(target_deployment_state,'')),100),''),
    'target',nullif(left(trim(coalesce(target_deployment_target,'')),100),''),
    'createdAt',coalesce(target_event_created_at,now())
  ));

  if resource_id_value is not null then
    update internal.integration_resources
    set metadata=coalesce(metadata,'{}'::jsonb)
      || jsonb_build_object('lastVercelEvent',event_snapshot)
      || case when target_event_type like 'deployment.%'
           then jsonb_build_object('lastDeployment',event_snapshot)
           else '{}'::jsonb end,
        updated_at=now()
    where id=resource_id_value;
  end if;

  update internal.integration_connections
  set metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
        'webhook',jsonb_build_object(
          'status','active',
          'mode','integration_console',
          'lastEventType',left(trim(target_event_type),160),
          'lastEventAt',coalesce(target_event_created_at,now())
        )
      ),
      last_synced_at=now()
  where id=target_connection_id;

  return true;
end
$$;

revoke all on function public.service_find_vercel_connections_for_webhook(text,text,text) from public,anon,authenticated;
revoke all on function public.service_record_vercel_webhook_event(uuid,text,text,timestamptz,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_find_vercel_connections_for_webhook(text,text,text) to service_role;
grant execute on function public.service_record_vercel_webhook_event(uuid,text,text,timestamptz,text,text,text,text,text,jsonb) to service_role;
