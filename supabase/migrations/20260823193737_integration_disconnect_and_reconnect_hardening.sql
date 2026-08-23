create or replace function public.disconnect_integration_connection(target_workspace_id uuid, target_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor_id uuid := auth.uid();
  org_id uuid;
  conn internal.integration_connections%rowtype;
  credential_secret uuid;
  pkce_secret uuid;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;

  select w.organization_id into org_id
  from public.workspaces w
  where w.id=target_workspace_id
    and internal.is_workspace_member(w.id);

  if org_id is null then
    raise exception 'workspace_access_denied' using errcode='42501';
  end if;
  if not internal.has_permission(org_id,'integration.manage') then
    raise exception 'permission_denied' using errcode='42501';
  end if;

  select * into conn
  from internal.integration_connections c
  where c.id=target_connection_id
    and c.organization_id=org_id
  for update;

  if not found then
    raise exception 'integration_connection_not_found';
  end if;

  credential_secret := conn.vault_secret_id;

  for pkce_secret in
    select s.pkce_secret_id
    from internal.integration_oauth_sessions s
    where s.connection_id=conn.id and s.pkce_secret_id is not null
  loop
    delete from vault.secrets where id=pkce_secret;
  end loop;

  update internal.integration_oauth_sessions
  set status=case when status='pending' then 'failed' else status end,
      error_code=case when status='pending' then 'disconnected' else error_code end,
      completed_at=case when status='pending' then coalesce(completed_at,now()) else completed_at end,
      pkce_secret_id=null
  where connection_id=conn.id;

  update internal.integration_tool_execution_grants
  set expires_at=least(expires_at,now()),
      finished_at=coalesce(finished_at,now()),
      outcome=coalesce(outcome,'revoked')
  where connection_id=conn.id
    and consumed_at is null;

  delete from public.conversation_resource_selections s
  where s.resource_id in (
    select r.id from internal.integration_resources r where r.connection_id=conn.id
  );

  update public.integration_resource_grants g
  set granted=false,
      updated_at=now()
  where g.resource_id in (
    select r.id from internal.integration_resources r where r.connection_id=conn.id
  );

  update public.project_integration_resources p
  set enabled=false,
      updated_at=now()
  where p.resource_id in (
    select r.id from internal.integration_resources r where r.connection_id=conn.id
  );

  update internal.integration_capabilities
  set granted=false
  where connection_id=conn.id;

  update internal.integration_resources
  set resource_status='disabled',
      updated_at=now()
  where connection_id=conn.id
    and resource_status <> 'removed';

  update internal.integration_connections
  set status='disconnected',
      vault_secret_id=null,
      credential_expires_at=null,
      disconnected_at=now(),
      last_error_code=null
  where id=conn.id;

  if credential_secret is not null then
    delete from vault.secrets where id=credential_secret;
  end if;

  insert into audit.audit_events(
    organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted
  ) values (
    org_id,actor_id,'integration.connection.disconnected','integration_connection',conn.id::text,'completed',
    jsonb_build_object('provider',conn.provider,'external_account_id',conn.external_account_id)
  );

  return jsonb_build_object(
    'id',conn.id,
    'provider',conn.provider,
    'status','disconnected'
  );
end $$;

revoke all on function public.disconnect_integration_connection(uuid,uuid) from public,anon;
grant execute on function public.disconnect_integration_connection(uuid,uuid) to authenticated;

create or replace function public.service_fail_integration_oauth_session(target_oauth_session_id uuid,target_error_code text)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  s internal.integration_oauth_sessions%rowtype;
  pkce_secret uuid;
  failure_code text := left(coalesce(target_error_code,'oauth_failed'),120);
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select pkce_secret_id into pkce_secret
  from internal.integration_oauth_sessions
  where id=target_oauth_session_id;

  update internal.integration_oauth_sessions
  set status='failed',
      error_code=failure_code,
      completed_at=now(),
      pkce_secret_id=null
  where id=target_oauth_session_id
  returning * into s;

  if pkce_secret is not null then
    delete from vault.secrets where id=pkce_secret;
  end if;

  if s.connection_id is not null then
    update internal.integration_connections
    set status=case when status='pending' then 'disconnected' else status end,
        disconnected_at=case when status='pending' then now() else disconnected_at end,
        last_error_code=failure_code
    where id=s.connection_id;
  end if;
end $$;

revoke all on function public.service_fail_integration_oauth_session(uuid,text) from public,anon,authenticated;
grant execute on function public.service_fail_integration_oauth_session(uuid,text) to service_role;

create or replace function public.service_prepare_integration_resource_sync(target_connection_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  update internal.integration_resources
  set resource_status='disabled',updated_at=now()
  where connection_id=target_connection_id and resource_status='available';
end $$;

revoke all on function public.service_prepare_integration_resource_sync(uuid) from public,anon,authenticated;
grant execute on function public.service_prepare_integration_resource_sync(uuid) to service_role;

create or replace function public.service_finalize_integration_resource_sync(target_connection_id uuid,target_error_code text default null)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  unavailable_count integer;
  available_count integer;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;
  select count(*) into unavailable_count
  from internal.integration_resources
  where connection_id=target_connection_id and resource_status='disabled';
  select count(*) into available_count
  from internal.integration_resources
  where connection_id=target_connection_id and resource_status='available';
  update internal.integration_connections
  set last_synced_at=now(),last_error_code=nullif(left(coalesce(target_error_code,''),120),'')
  where id=target_connection_id;
  return jsonb_build_object('connectionId',target_connection_id,'available',available_count,'unavailable',unavailable_count);
end $$;

revoke all on function public.service_finalize_integration_resource_sync(uuid,text) from public,anon,authenticated;
grant execute on function public.service_finalize_integration_resource_sync(uuid,text) to service_role;

update internal.integration_oauth_sessions
set status='expired',error_code=coalesce(error_code,'expired'),completed_at=coalesce(completed_at,now())
where status='pending' and expires_at<=now();

delete from vault.secrets
where id in (
  select s.pkce_secret_id
  from internal.integration_oauth_sessions s
  where s.pkce_secret_id is not null and s.status<>'pending'
);

update internal.integration_oauth_sessions
set pkce_secret_id=null
where pkce_secret_id is not null and status<>'pending';

update internal.integration_connections c
set status='disconnected',
    disconnected_at=coalesce(disconnected_at,now()),
    last_error_code=coalesce(last_error_code,'oauth_incomplete')
where c.status='pending'
  and not exists (
    select 1 from internal.integration_oauth_sessions s
    where s.connection_id=c.id and s.status='pending' and s.expires_at>now()
  );
