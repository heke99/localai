create index if not exists integration_connections_created_by_idx on internal.integration_connections(created_by);
create index if not exists integration_oauth_sessions_organization_idx on internal.integration_oauth_sessions(organization_id);
create index if not exists integration_oauth_sessions_workspace_idx on internal.integration_oauth_sessions(workspace_id);
create index if not exists integration_tool_execution_grants_actor_idx on internal.integration_tool_execution_grants(actor_user_id);
create index if not exists integration_tool_execution_grants_resource_idx on internal.integration_tool_execution_grants(resource_id);
create index if not exists integration_tool_execution_grants_connection_idx on internal.integration_tool_execution_grants(connection_id);

create or replace function public.service_find_github_connections_for_webhook(target_installation_id bigint, target_sender_id text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'connectionId', c.id,
      'organizationId', c.organization_id,
      'externalAccountId', c.external_account_id,
      'externalAccountName', c.external_account_name,
      'metadata', coalesce(c.metadata,'{}'::jsonb)
    ) order by c.created_at)
    from internal.integration_connections c
    where c.provider='github'
      and c.status in ('connected','active','ready')
      and (
        exists (
          select 1
          from jsonb_array_elements_text(coalesce(c.metadata->'installationIds','[]'::jsonb)) item(value)
          where item.value = target_installation_id::text
        )
        or (target_sender_id is not null and c.external_account_id = target_sender_id)
      )
  ), '[]'::jsonb);
end $$;
revoke all on function public.service_find_github_connections_for_webhook(bigint,text) from public,anon,authenticated;
grant execute on function public.service_find_github_connections_for_webhook(bigint,text) to service_role;

create or replace function public.service_update_integration_connection_discovery(target_connection_id uuid, target_metadata jsonb, target_capabilities text[])
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  org_id uuid;
  provider_name text;
  cap text;
  clean_caps text[] := '{}'::text[];
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select organization_id, provider into org_id, provider_name
  from internal.integration_connections
  where id=target_connection_id and status in ('connected','active','ready')
  for update;

  if org_id is null then raise exception 'integration_connection_not_found'; end if;
  if provider_name <> 'github' then raise exception 'unsupported_webhook_provider'; end if;

  foreach cap in array coalesce(target_capabilities,'{}'::text[]) loop
    if not exists (
      select 1 from internal.integration_capability_catalog cc
      where cc.provider=provider_name and cc.capability=cap
    ) then
      raise exception 'unknown_integration_capability:%',cap;
    end if;
    if not (cap = any(clean_caps)) then clean_caps := array_append(clean_caps,cap); end if;
  end loop;

  update internal.integration_connections
  set metadata=coalesce(target_metadata,'{}'::jsonb),
      last_synced_at=now(),
      last_error_code=null
  where id=target_connection_id;

  delete from internal.integration_capabilities where connection_id=target_connection_id;
  foreach cap in array clean_caps loop
    insert into internal.integration_capabilities(connection_id,capability,granted)
    values(target_connection_id,cap,true)
    on conflict(connection_id,capability) do update set granted=true;
  end loop;

  insert into audit.audit_events(organization_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values(org_id,'integration.webhook.synced','integration_connection',target_connection_id::text,'success',jsonb_build_object('provider',provider_name,'capability_count',cardinality(clean_caps)));

  return jsonb_build_object('connectionId',target_connection_id,'provider',provider_name,'metadata',coalesce(target_metadata,'{}'::jsonb),'capabilities',to_jsonb(clean_caps));
end $$;
revoke all on function public.service_update_integration_connection_discovery(uuid,jsonb,text[]) from public,anon,authenticated;
grant execute on function public.service_update_integration_connection_discovery(uuid,jsonb,text[]) to service_role;
