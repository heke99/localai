create unique index if not exists integration_connections_one_active_provider_idx
on internal.integration_connections(organization_id,provider)
where status in ('connected','active','ready');

create or replace function public.service_complete_integration_oauth_session(target_oauth_session_id uuid, target_external_account_id text, target_external_account_name text, target_credential_bundle jsonb, target_credential_expires_at timestamptz, target_metadata jsonb, target_capabilities text[])
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  s internal.integration_oauth_sessions%rowtype;
  pending internal.integration_connections%rowtype;
  conn internal.integration_connections%rowtype;
  other_conn internal.integration_connections%rowtype;
  existing_id uuid;
  secret_id uuid;
  cap text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into s from internal.integration_oauth_sessions where id=target_oauth_session_id and status='pending' for update;
  if not found or s.expires_at<=now() then raise exception 'oauth_session_invalid' using errcode='42501'; end if;
  if nullif(trim(target_external_account_id),'') is null then raise exception 'external_account_required'; end if;
  select * into pending from internal.integration_connections where id=s.connection_id for update;
  if not found then raise exception 'integration_connection_not_found'; end if;

  select id into existing_id from internal.integration_connections
  where organization_id=s.organization_id and provider=s.provider and external_account_id=left(trim(target_external_account_id),500) and id<>pending.id
  order by created_at desc limit 1;
  if existing_id is not null then
    select * into conn from internal.integration_connections where id=existing_id for update;
    update internal.integration_oauth_sessions set connection_id=existing_id where id=s.id;
    update internal.integration_connections
    set status='disconnected',external_account_id='disconnected:'||pending.id::text,external_account_name=null,metadata='{}'::jsonb,
        vault_secret_id=null,credential_expires_at=null,disconnected_at=now(),last_error_code='superseded',last_synced_at=null
    where id=pending.id;
  else
    conn := pending;
  end if;

  for other_conn in
    select * from internal.integration_connections c
    where c.organization_id=s.organization_id
      and c.provider=s.provider
      and c.id<>conn.id
      and c.status in ('connected','active','ready')
    for update
  loop
    update internal.integration_tool_execution_grants
    set expires_at=least(expires_at,now()),finished_at=coalesce(finished_at,now()),outcome=coalesce(outcome,'revoked')
    where connection_id=other_conn.id and consumed_at is null;

    delete from internal.integration_resources where connection_id=other_conn.id;
    delete from internal.integration_capabilities where connection_id=other_conn.id;
    if other_conn.vault_secret_id is not null then delete from vault.secrets where id=other_conn.vault_secret_id; end if;

    update internal.integration_connections
    set status='disconnected',external_account_id='disconnected:'||other_conn.id::text,external_account_name=null,metadata='{}'::jsonb,
        vault_secret_id=null,credential_expires_at=null,disconnected_at=now(),last_error_code='superseded_by_reconnect',last_synced_at=null
    where id=other_conn.id;
  end loop;

  if target_credential_bundle is not null then
    if conn.vault_secret_id is null then
      secret_id := vault.create_secret(target_credential_bundle::text,'integration-token-'||conn.id::text,'OAuth token bundle for integration connection');
    else
      secret_id := conn.vault_secret_id;
      perform vault.update_secret(secret_id,target_credential_bundle::text,null,null,null);
    end if;
  else secret_id := conn.vault_secret_id; end if;

  update internal.integration_connections set
    external_account_id=left(trim(target_external_account_id),500),
    external_account_name=nullif(left(trim(coalesce(target_external_account_name,'')),240),''),
    vault_secret_id=secret_id,
    status='connected',metadata=coalesce(target_metadata,'{}'::jsonb),
    credential_expires_at=target_credential_expires_at,last_error_code=null,disconnected_at=null
  where id=conn.id returning * into conn;

  delete from internal.integration_capabilities where connection_id=conn.id;
  foreach cap in array coalesce(target_capabilities,'{}'::text[]) loop
    if not exists(select 1 from internal.integration_capability_catalog c where c.provider=s.provider and c.capability=cap) then raise exception 'unknown_integration_capability:%',cap; end if;
    insert into internal.integration_capabilities(connection_id,capability,granted) values(conn.id,cap,true)
    on conflict(connection_id,capability) do update set granted=true;
  end loop;

  update internal.integration_oauth_sessions set status='completed',completed_at=now(),connection_id=conn.id where id=s.id;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values(s.organization_id,s.actor_user_id,'integration.oauth.completed','integration_connection',conn.id::text,'completed',jsonb_build_object('provider',s.provider,'external_account_id',conn.external_account_id));
  return jsonb_build_object('id',conn.id,'provider',conn.provider,'status',conn.status,'external_account_id',conn.external_account_id,'external_account_name',conn.external_account_name,'workspaceId',s.workspace_id,'returnPath',s.return_path);
end
$function$;

revoke all on function public.service_complete_integration_oauth_session(uuid,text,text,jsonb,timestamptz,jsonb,text[]) from public,anon,authenticated;
grant execute on function public.service_complete_integration_oauth_session(uuid,text,text,jsonb,timestamptz,jsonb,text[]) to service_role;