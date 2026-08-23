alter table internal.integration_connections
  add column if not exists external_account_name text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists credential_expires_at timestamptz,
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists disconnected_at timestamptz;

create table if not exists internal.integration_oauth_sessions (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references internal.integration_connections(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('github','supabase','vercel')),
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null unique,
  pkce_secret_id uuid,
  return_path text not null default '/dashboard',
  status text not null default 'pending' check (status in ('pending','completed','failed','expired')),
  error_code text,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists integration_oauth_sessions_actor_status_idx on internal.integration_oauth_sessions(actor_user_id,status,created_at desc);
create index if not exists integration_oauth_sessions_connection_idx on internal.integration_oauth_sessions(connection_id);
alter table internal.integration_oauth_sessions enable row level security;
revoke all on internal.integration_oauth_sessions from public,anon,authenticated;

create table if not exists internal.integration_tool_execution_grants (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references internal.agent_runs(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  resource_id uuid not null references internal.integration_resources(id) on delete cascade,
  connection_id uuid not null references internal.integration_connections(id) on delete cascade,
  provider text not null,
  capability text not null,
  tool_name text not null,
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  consumed_at timestamptz,
  finished_at timestamptz,
  outcome text,
  result_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists integration_tool_execution_grants_run_idx on internal.integration_tool_execution_grants(run_id,created_at desc);
create index if not exists integration_tool_execution_grants_expiry_idx on internal.integration_tool_execution_grants(expires_at) where consumed_at is null;
alter table internal.integration_tool_execution_grants enable row level security;
revoke all on internal.integration_tool_execution_grants from public,anon,authenticated;

create or replace function public.begin_integration_oauth(target_workspace_id uuid,target_provider text,target_state text,target_code_verifier text default null,target_return_path text default '/dashboard') returns jsonb
language plpgsql security definer set search_path=''
as $$
declare actor_id uuid := auth.uid(); org_id uuid; normalized_provider text := lower(trim(coalesce(target_provider,''))); safe_return_path text := case when coalesce(target_return_path,'') ~ '^/[A-Za-z0-9_/?=&.%+-]*$' then target_return_path else '/dashboard' end; conn internal.integration_connections%rowtype; oauth_row internal.integration_oauth_sessions%rowtype; verifier_secret uuid; state_digest text;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id=target_workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode='42501'; end if;
  if not internal.has_permission(org_id,'integration.manage') then raise exception 'permission_denied' using errcode='42501'; end if;
  if normalized_provider not in ('github','supabase','vercel') then raise exception 'provider_not_supported'; end if;
  if length(target_state) < 32 or length(target_state) > 256 then raise exception 'invalid_oauth_state'; end if;
  if target_code_verifier is not null and (length(target_code_verifier) < 43 or length(target_code_verifier) > 128) then raise exception 'invalid_pkce_verifier'; end if;
  update internal.integration_oauth_sessions set status='expired',error_code='superseded' where actor_user_id=actor_id and provider=normalized_provider and status='pending';
  select * into conn from internal.integration_connections where organization_id=org_id and provider=normalized_provider and created_by=actor_id and status='pending' order by created_at desc limit 1;
  if not found then insert into internal.integration_connections(organization_id,provider,external_account_id,status,created_by) values(org_id,normalized_provider,'pending:'||actor_id::text,'pending',actor_id) on conflict(organization_id,provider,external_account_id) do update set status='pending',last_error_code=null,disconnected_at=null returning * into conn; end if;
  if target_code_verifier is not null then verifier_secret := vault.create_secret(target_code_verifier,'integration-oauth-pkce-'||gen_random_uuid()::text,'Short-lived PKCE verifier'); end if;
  state_digest := encode(extensions.digest(target_state,'sha256'),'hex');
  insert into internal.integration_oauth_sessions(connection_id,organization_id,workspace_id,provider,actor_user_id,state_hash,pkce_secret_id,return_path) values(conn.id,org_id,target_workspace_id,normalized_provider,actor_id,state_digest,verifier_secret,safe_return_path) returning * into oauth_row;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values(org_id,actor_id,'integration.oauth.started','integration_connection',conn.id::text,'accepted',jsonb_build_object('provider',normalized_provider));
  return jsonb_build_object('oauthSessionId',oauth_row.id,'connectionId',conn.id,'provider',normalized_provider,'returnPath',safe_return_path,'expiresAt',oauth_row.expires_at);
end $$;
revoke all on function public.begin_integration_oauth(uuid,text,text,text,text) from public,anon;
grant execute on function public.begin_integration_oauth(uuid,text,text,text,text) to authenticated;

create or replace function public.service_get_integration_oauth_session(target_provider text,target_state text,target_actor_user_id uuid) returns jsonb language plpgsql security definer set search_path=''
as $$ declare s internal.integration_oauth_sessions%rowtype; verifier text; begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into s from internal.integration_oauth_sessions where provider=lower(trim(target_provider)) and actor_user_id=target_actor_user_id and state_hash=encode(extensions.digest(target_state,'sha256'),'hex') and status='pending' order by created_at desc limit 1 for update;
  if not found then raise exception 'oauth_session_not_found' using errcode='42501'; end if;
  if s.expires_at <= now() then update internal.integration_oauth_sessions set status='expired',error_code='expired' where id=s.id; raise exception 'oauth_session_expired' using errcode='42501'; end if;
  if s.pkce_secret_id is not null then select decrypted_secret into verifier from vault.decrypted_secrets where id=s.pkce_secret_id; end if;
  return jsonb_build_object('oauthSessionId',s.id,'connectionId',s.connection_id,'organizationId',s.organization_id,'workspaceId',s.workspace_id,'provider',s.provider,'actorUserId',s.actor_user_id,'returnPath',s.return_path,'codeVerifier',verifier);
end $$;
revoke all on function public.service_get_integration_oauth_session(text,text,uuid) from public,anon,authenticated;
grant execute on function public.service_get_integration_oauth_session(text,text,uuid) to service_role;

create or replace function public.service_complete_integration_oauth_session(target_oauth_session_id uuid,target_external_account_id text,target_external_account_name text,target_credential_bundle jsonb,target_credential_expires_at timestamptz,target_metadata jsonb,target_capabilities text[]) returns jsonb language plpgsql security definer set search_path=''
as $$ declare s internal.integration_oauth_sessions%rowtype; pending internal.integration_connections%rowtype; conn internal.integration_connections%rowtype; existing_id uuid; secret_id uuid; cap text; begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select * into s from internal.integration_oauth_sessions where id=target_oauth_session_id and status='pending' for update;
  if not found or s.expires_at<=now() then raise exception 'oauth_session_invalid' using errcode='42501'; end if;
  if nullif(trim(target_external_account_id),'') is null then raise exception 'external_account_required'; end if;
  select * into pending from internal.integration_connections where id=s.connection_id for update; if not found then raise exception 'integration_connection_not_found'; end if;
  select id into existing_id from internal.integration_connections where organization_id=s.organization_id and provider=s.provider and external_account_id=left(trim(target_external_account_id),500) and id<>pending.id order by created_at desc limit 1;
  if existing_id is not null then select * into conn from internal.integration_connections where id=existing_id for update; update internal.integration_oauth_sessions set connection_id=existing_id where id=s.id; update internal.integration_connections set status='disconnected',disconnected_at=now(),last_error_code='superseded' where id=pending.id; else conn := pending; end if;
  if target_credential_bundle is not null then if conn.vault_secret_id is null then secret_id := vault.create_secret(target_credential_bundle::text,'integration-token-'||conn.id::text,'OAuth token bundle for integration connection'); else secret_id := conn.vault_secret_id; perform vault.update_secret(secret_id,target_credential_bundle::text,null,null,null); end if; else secret_id := conn.vault_secret_id; end if;
  update internal.integration_connections set external_account_id=left(trim(target_external_account_id),500),external_account_name=nullif(left(trim(coalesce(target_external_account_name,'')),240),''),vault_secret_id=secret_id,status='connected',metadata=coalesce(target_metadata,'{}'::jsonb),credential_expires_at=target_credential_expires_at,last_error_code=null,disconnected_at=null where id=conn.id returning * into conn;
  delete from internal.integration_capabilities where connection_id=conn.id;
  foreach cap in array coalesce(target_capabilities,'{}'::text[]) loop if not exists(select 1 from internal.integration_capability_catalog c where c.provider=s.provider and c.capability=cap) then raise exception 'unknown_integration_capability:%',cap; end if; insert into internal.integration_capabilities(connection_id,capability,granted) values(conn.id,cap,true) on conflict(connection_id,capability) do update set granted=true; end loop;
  update internal.integration_oauth_sessions set status='completed',completed_at=now(),connection_id=conn.id where id=s.id;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values(s.organization_id,s.actor_user_id,'integration.oauth.completed','integration_connection',conn.id::text,'completed',jsonb_build_object('provider',s.provider,'external_account_id',conn.external_account_id));
  return jsonb_build_object('id',conn.id,'provider',conn.provider,'status',conn.status,'external_account_id',conn.external_account_id,'external_account_name',conn.external_account_name,'workspaceId',s.workspace_id,'returnPath',s.return_path);
end $$;
revoke all on function public.service_complete_integration_oauth_session(uuid,text,text,jsonb,timestamptz,jsonb,text[]) from public,anon,authenticated;
grant execute on function public.service_complete_integration_oauth_session(uuid,text,text,jsonb,timestamptz,jsonb,text[]) to service_role;

create or replace function public.service_fail_integration_oauth_session(target_oauth_session_id uuid,target_error_code text) returns void language plpgsql security definer set search_path=''
as $$ declare s internal.integration_oauth_sessions%rowtype; begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; update internal.integration_oauth_sessions set status='failed',error_code=left(coalesce(target_error_code,'oauth_failed'),120),completed_at=now() where id=target_oauth_session_id returning * into s; if s.connection_id is not null then update internal.integration_connections set last_error_code=left(coalesce(target_error_code,'oauth_failed'),120) where id=s.connection_id; end if; end $$;
revoke all on function public.service_fail_integration_oauth_session(uuid,text) from public,anon,authenticated; grant execute on function public.service_fail_integration_oauth_session(uuid,text) to service_role;

create or replace function public.service_prepare_integration_resource_sync(target_connection_id uuid) returns void language plpgsql security definer set search_path=''
as $$ begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; update internal.integration_resources set resource_status='stale',updated_at=now() where connection_id=target_connection_id and resource_status='available'; end $$;
revoke all on function public.service_prepare_integration_resource_sync(uuid) from public,anon,authenticated; grant execute on function public.service_prepare_integration_resource_sync(uuid) to service_role;

create or replace function public.service_finalize_integration_resource_sync(target_connection_id uuid,target_error_code text default null) returns jsonb language plpgsql security definer set search_path=''
as $$ declare unavailable_count integer; available_count integer; begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; update internal.integration_resources set resource_status='unavailable',updated_at=now() where connection_id=target_connection_id and resource_status='stale'; get diagnostics unavailable_count=row_count; select count(*) into available_count from internal.integration_resources where connection_id=target_connection_id and resource_status='available'; update internal.integration_connections set last_synced_at=now(),last_error_code=nullif(left(coalesce(target_error_code,''),120),'') where id=target_connection_id; return jsonb_build_object('connectionId',target_connection_id,'available',available_count,'unavailable',unavailable_count); end $$;
revoke all on function public.service_finalize_integration_resource_sync(uuid,text) from public,anon,authenticated; grant execute on function public.service_finalize_integration_resource_sync(uuid,text) to service_role;

create or replace function public.service_get_integration_credential(target_connection_id uuid) returns jsonb language plpgsql stable security definer set search_path=''
as $$ declare c internal.integration_connections%rowtype; secret_text text; begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; select * into c from internal.integration_connections where id=target_connection_id and status in ('connected','active','ready'); if not found then raise exception 'integration_connection_not_connected' using errcode='42501'; end if; if c.vault_secret_id is not null then select decrypted_secret into secret_text from vault.decrypted_secrets where id=c.vault_secret_id; end if; return jsonb_build_object('connectionId',c.id,'provider',c.provider,'credential',case when secret_text is null then null else secret_text::jsonb end,'credentialExpiresAt',c.credential_expires_at,'metadata',c.metadata); end $$;
revoke all on function public.service_get_integration_credential(uuid) from public,anon,authenticated; grant execute on function public.service_get_integration_credential(uuid) to service_role;

create or replace function public.service_update_integration_credential(target_connection_id uuid,target_credential_bundle jsonb,target_credential_expires_at timestamptz) returns void language plpgsql security definer set search_path=''
as $$ declare sid uuid; begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; select vault_secret_id into sid from internal.integration_connections where id=target_connection_id for update; if sid is null then sid:=vault.create_secret(target_credential_bundle::text,'integration-token-'||target_connection_id::text,'OAuth token bundle for integration connection'); else perform vault.update_secret(sid,target_credential_bundle::text,null,null,null); end if; update internal.integration_connections set vault_secret_id=sid,credential_expires_at=target_credential_expires_at,last_error_code=null where id=target_connection_id; end $$;
revoke all on function public.service_update_integration_credential(uuid,jsonb,timestamptz) from public,anon,authenticated; grant execute on function public.service_update_integration_credential(uuid,jsonb,timestamptz) to service_role;

create or replace function public.worker_create_tool_execution_grant(target_run_id uuid,target_resource_id uuid,target_capability text,target_tool_name text) returns jsonb language plpgsql security definer set search_path=''
as $$ declare authz jsonb; gid uuid; begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; authz:=public.worker_authorize_tool_call(target_run_id,target_resource_id,target_capability); insert into internal.integration_tool_execution_grants(run_id,actor_user_id,resource_id,connection_id,provider,capability,tool_name) values(target_run_id,(authz->>'actorId')::uuid,target_resource_id,(authz->>'connectionId')::uuid,authz->>'provider',target_capability,left(target_tool_name,160)) returning id into gid; return authz || jsonb_build_object('executionGrantId',gid,'expiresInSeconds',120); end $$;
revoke all on function public.worker_create_tool_execution_grant(uuid,uuid,text,text) from public,anon,authenticated; grant execute on function public.worker_create_tool_execution_grant(uuid,uuid,text,text) to service_role;

create or replace function public.service_consume_integration_tool_execution_grant(target_grant_id uuid,target_tool_name text) returns jsonb language plpgsql security definer set search_path=''
as $$ declare g internal.integration_tool_execution_grants%rowtype; c internal.integration_connections%rowtype; r internal.integration_resources%rowtype; credential_text text; begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; update internal.integration_tool_execution_grants set consumed_at=now() where id=target_grant_id and consumed_at is null and expires_at>now() and tool_name=target_tool_name returning * into g; if not found then raise exception 'execution_grant_invalid_or_consumed' using errcode='42501'; end if; select * into c from internal.integration_connections where id=g.connection_id and status in ('connected','active','ready'); select * into r from internal.integration_resources where id=g.resource_id and connection_id=g.connection_id and resource_status='available'; if c.id is null or r.id is null then raise exception 'integration_resource_unavailable' using errcode='42501'; end if; if c.vault_secret_id is not null then select decrypted_secret into credential_text from vault.decrypted_secrets where id=c.vault_secret_id; end if; return jsonb_build_object('grantId',g.id,'runId',g.run_id,'actorUserId',g.actor_user_id,'resourceId',g.resource_id,'connectionId',g.connection_id,'provider',g.provider,'capability',g.capability,'toolName',g.tool_name,'externalResourceId',r.external_id,'displayName',coalesce(r.display_name,r.external_id),'resourceMetadata',r.metadata,'connectionMetadata',c.metadata,'credential',case when credential_text is null then null else credential_text::jsonb end,'credentialExpiresAt',c.credential_expires_at); end $$;
revoke all on function public.service_consume_integration_tool_execution_grant(uuid,text) from public,anon,authenticated; grant execute on function public.service_consume_integration_tool_execution_grant(uuid,text) to service_role;

create or replace function public.service_finish_integration_tool_execution_grant(target_grant_id uuid,target_outcome text,target_result_metadata jsonb default '{}'::jsonb) returns void language plpgsql security definer set search_path=''
as $$ declare g internal.integration_tool_execution_grants%rowtype; org_id uuid; begin if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; update internal.integration_tool_execution_grants set finished_at=now(),outcome=left(coalesce(target_outcome,'completed'),40),result_metadata=coalesce(target_result_metadata,'{}'::jsonb) where id=target_grant_id and consumed_at is not null returning * into g; if not found then return; end if; select organization_id into org_id from internal.integration_connections where id=g.connection_id; insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values(org_id,g.actor_user_id,'integration.tool.executed','integration_resource',g.resource_id::text,coalesce(target_outcome,'completed'),jsonb_build_object('provider',g.provider,'capability',g.capability,'tool',g.tool_name,'run_id',g.run_id)||coalesce(target_result_metadata,'{}'::jsonb)); end $$;
revoke all on function public.service_finish_integration_tool_execution_grant(uuid,text,jsonb) from public,anon,authenticated; grant execute on function public.service_finish_integration_tool_execution_grant(uuid,text,jsonb) to service_role;