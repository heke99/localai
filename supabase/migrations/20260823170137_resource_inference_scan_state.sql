create or replace function public.service_conversation_relationship_inference_context(target_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  pid uuid;
  oid uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'service_role_required' using errcode='42501';
  end if;

  select c.project_id, w.organization_id into pid, oid
  from public.conversations c
  join public.workspaces w on w.id = c.workspace_id
  where c.id = target_conversation_id;

  if pid is null or oid is null then
    return jsonb_build_object('projectId', null, 'organizationId', oid, 'resources', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'projectId', pid,
    'organizationId', oid,
    'resources', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'resourceId', ir.id,
        'connectionId', ir.connection_id,
        'provider', ic.provider,
        'resourceType', ir.resource_type,
        'externalResourceId', ir.external_id,
        'displayName', coalesce(ir.display_name,ir.external_id),
        'metadata', ir.metadata,
        'selected', exists(
          select 1 from public.conversation_resource_selections s
          where s.conversation_id = target_conversation_id and s.resource_id = ir.id
        ),
        'identifiers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'kind', ii.kind,
            'value', ii.normalized_value,
            'source', ii.source_kind,
            'confidence', ii.confidence,
            'linkable', ii.linkable
          ) order by ii.kind,ii.normalized_value)
          from internal.integration_resource_identifiers ii
          where ii.resource_id = ir.id
        ), '[]'::jsonb)
      ) order by ic.provider, coalesce(ir.display_name,ir.external_id)), '[]'::jsonb)
      from public.project_integration_resources pir
      join internal.integration_resources ir on ir.id = pir.resource_id and ir.resource_status = 'available'
      join internal.integration_connections ic on ic.id = ir.connection_id
        and ic.organization_id = oid and ic.status in ('connected','active','ready')
      where pir.project_id = pid and pir.enabled
    )
  );
end;
$$;

revoke all on function public.service_conversation_relationship_inference_context(uuid) from public, anon, authenticated;
grant execute on function public.service_conversation_relationship_inference_context(uuid) to service_role;
