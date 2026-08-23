create or replace function public.disconnect_integration_connection(target_workspace_id uuid, target_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
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

  delete from internal.integration_resources
  where connection_id=conn.id;

  delete from internal.integration_capabilities
  where connection_id=conn.id;

  update internal.integration_connections
  set status='disconnected',
      external_account_id='disconnected:'||conn.id::text,
      external_account_name=null,
      metadata='{}'::jsonb,
      vault_secret_id=null,
      credential_expires_at=null,
      disconnected_at=now(),
      last_error_code=null,
      last_synced_at=null
  where id=conn.id;

  if credential_secret is not null then
    delete from vault.secrets where id=credential_secret;
  end if;

  insert into audit.audit_events(
    organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted
  ) values (
    org_id,actor_id,'integration.connection.disconnected','integration_connection',conn.id::text,'completed',
    jsonb_build_object('provider',conn.provider,'identityForgotten',true)
  );

  return jsonb_build_object(
    'id',conn.id,
    'provider',conn.provider,
    'status','disconnected'
  );
end
$function$;

revoke all on function public.disconnect_integration_connection(uuid,uuid) from public,anon;
grant execute on function public.disconnect_integration_connection(uuid,uuid) to authenticated;

delete from internal.integration_resources r
where exists (
  select 1 from internal.integration_connections c
  where c.id=r.connection_id and c.status='disconnected'
);

delete from internal.integration_capabilities cap
where exists (
  select 1 from internal.integration_connections c
  where c.id=cap.connection_id and c.status='disconnected'
);

update internal.integration_connections
set external_account_id='disconnected:'||id::text,
    external_account_name=null,
    metadata='{}'::jsonb,
    vault_secret_id=null,
    credential_expires_at=null,
    last_synced_at=null
where status='disconnected';

create or replace function public.workspace_dashboard_snapshot(target_workspace_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $function$
declare actor_id uuid:=auth.uid(); org_id uuid;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id=target_workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode='42501'; end if;
  return jsonb_build_object(
    'projects',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select p.id,p.name,p.description,p.mode,p.created_at,p.updated_at,(select count(*) from public.conversations c where c.project_id=p.id) as conversation_count,coalesce(nullif((select count(*) from public.project_integration_resources pir join internal.integration_resources ir on ir.id=pir.resource_id where pir.project_id=p.id and pir.enabled and ir.resource_type='repository'),0),(select count(*) from public.project_repositories pr where pr.project_id=p.id)) as repository_count from public.projects p where p.workspace_id=target_workspace_id and p.system_kind is null)x),
    'conversations',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select c.id,case when p.system_kind is not null then null else c.project_id end as project_id,c.mode,c.title,c.created_at,c.updated_at,(select max(m.created_at) from public.messages m where m.conversation_id=c.id) as last_message_at,coalesce((select jsonb_agg(s.resource_id order by s.selected_at) from public.conversation_resource_selections s where s.conversation_id=c.id),'[]'::jsonb) as selected_resource_ids from public.conversations c left join public.projects p on p.id=c.project_id where c.workspace_id=target_workspace_id order by c.updated_at desc limit 250)x),
    'integrations',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.created_at desc),'[]'::jsonb) from (select ic.id,ic.provider,ic.external_account_id,ic.external_account_name,ic.metadata,ic.status,ic.created_at,ic.last_synced_at,ic.disconnected_at,coalesce((select jsonb_object_agg(cap.capability,cap.granted) from internal.integration_capabilities cap where cap.connection_id=ic.id),'{}'::jsonb) as capabilities from internal.integration_connections ic where ic.organization_id=org_id)x),
    'available_resources',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.display_name),'[]'::jsonb) from (select ir.id,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,ir.resource_status as status,ic.status as connection_status,coalesce((select jsonb_agg(cap.capability order by cap.capability) from internal.integration_capabilities cap where cap.connection_id=ir.connection_id and cap.granted),'[]'::jsonb) as provider_capabilities from internal.integration_resources ir join internal.integration_connections ic on ic.id=ir.connection_id where ic.organization_id=org_id and ir.resource_status='available')x),
    'project_resources',(select coalesce(jsonb_agg(row_to_json(x) order by x.project_id,x.provider,x.display_name),'[]'::jsonb) from (select pir.project_id,pir.resource_id,pir.enabled,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,coalesce((select jsonb_agg(g.capability order by g.capability) from public.integration_resource_grants g where g.project_id=pir.project_id and g.resource_id=ir.id and g.granted),'[]'::jsonb) as capabilities from public.project_integration_resources pir join public.projects p on p.id=pir.project_id and p.system_kind is null join internal.integration_resources ir on ir.id=pir.resource_id join internal.integration_connections ic on ic.id=ir.connection_id where p.workspace_id=target_workspace_id)x),
    'resource_links',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select l.id,l.project_id,l.resource_a_id,l.resource_b_id,l.relation_key,l.status,l.confidence,l.source_kind,l.note,l.updated_at from public.project_resource_links l join public.projects p on p.id=l.project_id where p.workspace_id=target_workspace_id and p.system_kind is null)x),
    'capability_catalog',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.capability),'[]'::jsonb) from (select provider,capability,label,risk,resource_type,description from internal.integration_capability_catalog)x)
  );
end
$function$;