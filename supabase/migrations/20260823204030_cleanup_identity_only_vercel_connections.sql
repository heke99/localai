do $function$
declare c internal.integration_connections%rowtype;
begin
  for c in
    select * from internal.integration_connections
    where provider='vercel'
      and status in ('connected','active','ready')
      and coalesce((metadata->>'accessibleProjectCount')::integer,0)=0
      and coalesce(jsonb_array_length(case when jsonb_typeof(metadata->'teamIds')='array' then metadata->'teamIds' else '[]'::jsonb end),0)=0
  loop
    update internal.integration_tool_execution_grants
    set expires_at=least(expires_at,now()),finished_at=coalesce(finished_at,now()),outcome=coalesce(outcome,'revoked')
    where connection_id=c.id and consumed_at is null;
    delete from internal.integration_resources where connection_id=c.id;
    delete from internal.integration_capabilities where connection_id=c.id;
    if c.vault_secret_id is not null then delete from vault.secrets where id=c.vault_secret_id; end if;
    update internal.integration_connections
    set status='disconnected',external_account_id='disconnected:'||c.id::text,external_account_name=null,metadata='{}'::jsonb,
        vault_secret_id=null,credential_expires_at=null,disconnected_at=now(),last_synced_at=null,last_error_code='vercel_project_scope_required'
    where id=c.id;
  end loop;
end
$function$;