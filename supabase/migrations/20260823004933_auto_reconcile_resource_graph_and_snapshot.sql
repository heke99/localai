create or replace function internal.has_permission_for_user(org_id uuid,target_user_id uuid,permission_key text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u where u.id=target_user_id and u.raw_app_meta_data->>'system_role'='superadmin')
    or exists(select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id=ur.role_id join public.permissions p on p.id=rp.permission_id where ur.organization_id=org_id and ur.user_id=target_user_id and p.key=permission_key)
$$;

create or replace function internal.reconcile_links_for_resource(target_resource_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare affected integer:=0;
begin
  insert into public.project_resource_links(project_id,resource_a_id,resource_b_id,relation_key,status,confidence,source_kind,note)
  select p1.project_id,
    case when i1.resource_id::text<i2.resource_id::text then i1.resource_id else i2.resource_id end,
    case when i1.resource_id::text<i2.resource_id::text then i2.resource_id else i1.resource_id end,
    'same_application',
    case when i1.confidence>=0.99 and i2.confidence>=0.99 and i1.source_kind='provider' and i2.source_kind='provider' then 'confirmed' else 'suggested' end,
    least(i1.confidence,i2.confidence),'inferred',left('Exact shared identifier: '||i1.kind,2000)
  from internal.integration_resource_identifiers i1
  join internal.integration_resource_identifiers i2 on i2.kind=i1.kind and i2.normalized_value=i1.normalized_value and i2.resource_id<>i1.resource_id and i1.linkable and i2.linkable
  join public.project_integration_resources p1 on p1.resource_id=i1.resource_id and p1.enabled
  join public.project_integration_resources p2 on p2.project_id=p1.project_id and p2.resource_id=i2.resource_id and p2.enabled
  join internal.integration_resources r1 on r1.id=i1.resource_id join internal.integration_connections c1 on c1.id=r1.connection_id
  join internal.integration_resources r2 on r2.id=i2.resource_id join internal.integration_connections c2 on c2.id=r2.connection_id
  where (i1.resource_id=target_resource_id or i2.resource_id=target_resource_id) and c1.provider<>c2.provider and i1.confidence>=0.9 and i2.confidence>=0.9
  on conflict(project_id,resource_a_id,resource_b_id,relation_key) do update set confidence=greatest(public.project_resource_links.confidence,excluded.confidence),status=case when public.project_resource_links.status='rejected' then 'rejected' when excluded.status='confirmed' then 'confirmed' else public.project_resource_links.status end,updated_at=now();
  get diagnostics affected=row_count;
  return affected;
end $$;

create or replace function internal.integration_identifier_reconcile_trigger() returns trigger language plpgsql security definer set search_path='' as $$ begin perform internal.reconcile_links_for_resource(new.resource_id); return new; end $$;
create or replace function internal.project_resource_reconcile_trigger() returns trigger language plpgsql security definer set search_path='' as $$ begin if new.enabled then perform internal.reconcile_links_for_resource(new.resource_id); end if; return new; end $$;

drop trigger if exists integration_identifier_reconcile on internal.integration_resource_identifiers;
create trigger integration_identifier_reconcile after insert or update of normalized_value,confidence,linkable,source_kind on internal.integration_resource_identifiers for each row execute function internal.integration_identifier_reconcile_trigger();
drop trigger if exists project_resource_reconcile on public.project_integration_resources;
create trigger project_resource_reconcile after insert or update of enabled on public.project_integration_resources for each row execute function internal.project_resource_reconcile_trigger();

create or replace function public.reconcile_project_resource_links(target_project_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare affected integer:=0;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  insert into public.project_resource_links(project_id,resource_a_id,resource_b_id,relation_key,status,confidence,source_kind,note)
  select target_project_id,i1.resource_id,i2.resource_id,'same_application',case when i1.confidence>=0.99 and i2.confidence>=0.99 and i1.source_kind='provider' and i2.source_kind='provider' then 'confirmed' else 'suggested' end,least(i1.confidence,i2.confidence),'inferred',left('Exact shared identifier: '||i1.kind,2000)
  from internal.integration_resource_identifiers i1
  join internal.integration_resource_identifiers i2 on i2.kind=i1.kind and i2.normalized_value=i1.normalized_value and i1.resource_id::text<i2.resource_id::text and i1.linkable and i2.linkable
  join public.project_integration_resources p1 on p1.project_id=target_project_id and p1.resource_id=i1.resource_id and p1.enabled
  join public.project_integration_resources p2 on p2.project_id=target_project_id and p2.resource_id=i2.resource_id and p2.enabled
  join internal.integration_resources r1 on r1.id=i1.resource_id join internal.integration_connections c1 on c1.id=r1.connection_id
  join internal.integration_resources r2 on r2.id=i2.resource_id join internal.integration_connections c2 on c2.id=r2.connection_id
  where c1.provider<>c2.provider and i1.confidence>=0.9 and i2.confidence>=0.9
  on conflict(project_id,resource_a_id,resource_b_id,relation_key) do update set confidence=greatest(public.project_resource_links.confidence,excluded.confidence),status=case when public.project_resource_links.status='rejected' then 'rejected' when excluded.status='confirmed' then 'confirmed' else public.project_resource_links.status end,updated_at=now();
  get diagnostics affected=row_count;
  return affected;
end $$;

create or replace function internal.conversation_reachable_resources(target_conversation_id uuid)
returns table(project_id uuid,resource_id uuid,depth integer,selected boolean) language sql stable security definer set search_path='' as $$
  with recursive walk as (
    select c.project_id,s.resource_id,0 as depth,array[s.resource_id]::uuid[] as path from public.conversations c join public.conversation_resource_selections s on s.conversation_id=c.id where c.id=target_conversation_id and c.project_id is not null
    union all
    select w.project_id,case when l.resource_a_id=w.resource_id then l.resource_b_id else l.resource_a_id end,w.depth+1,w.path || case when l.resource_a_id=w.resource_id then l.resource_b_id else l.resource_a_id end
    from walk w join public.project_resource_links l on l.project_id=w.project_id and l.status='confirmed' and (l.resource_a_id=w.resource_id or l.resource_b_id=w.resource_id)
    where w.depth<4 and not (case when l.resource_a_id=w.resource_id then l.resource_b_id else l.resource_a_id end=any(w.path))
  )
  select w.project_id,w.resource_id,min(w.depth)::integer,bool_or(w.depth=0) from walk w group by w.project_id,w.resource_id
$$;

create or replace function internal.resource_context_for_conversation(target_conversation_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('resourceId',ir.id,'connectionId',ir.connection_id,'provider',ic.provider,'resourceType',ir.resource_type,'externalResourceId',ir.external_id,'displayName',coalesce(ir.display_name,ir.external_id),'metadata',ir.metadata,'selected',reachable.selected,'linkDepth',reachable.depth,'capabilities',coalesce((select jsonb_agg(g.capability order by g.capability) from public.integration_resource_grants g where g.project_id=reachable.project_id and g.resource_id=ir.id and g.granted),'[]'::jsonb)) order by reachable.depth,ic.provider,coalesce(ir.display_name,ir.external_id)),'[]'::jsonb)
  from internal.conversation_reachable_resources(target_conversation_id) reachable
  join public.project_integration_resources pir on pir.project_id=reachable.project_id and pir.resource_id=reachable.resource_id and pir.enabled
  join internal.integration_resources ir on ir.id=reachable.resource_id and ir.resource_status='available'
  join internal.integration_connections ic on ic.id=ir.connection_id and ic.status in ('connected','active','ready')
$$;

create or replace function public.conversation_resource_context(target_conversation_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if not exists(select 1 from public.conversations c where c.id=target_conversation_id and internal.is_workspace_member(c.workspace_id)) then raise exception 'conversation_access_denied' using errcode='42501'; end if;
  return internal.resource_context_for_conversation(target_conversation_id);
end $$;

create or replace function public.workspace_dashboard_snapshot(target_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor_id uuid:=auth.uid(); org_id uuid;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id from public.workspaces w where w.id=target_workspace_id and internal.is_workspace_member(w.id);
  if org_id is null then raise exception 'workspace_access_denied' using errcode='42501'; end if;
  return jsonb_build_object(
    'projects',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select p.id,p.name,p.description,p.created_at,p.updated_at,(select count(*) from public.conversations c where c.project_id=p.id) as conversation_count,coalesce(nullif((select count(*) from public.project_integration_resources pir join internal.integration_resources ir on ir.id=pir.resource_id where pir.project_id=p.id and pir.enabled and ir.resource_type='repository'),0),(select count(*) from public.project_repositories pr where pr.project_id=p.id)) as repository_count from public.projects p where p.workspace_id=target_workspace_id)x),
    'conversations',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select c.id,c.project_id,c.mode,c.title,c.created_at,c.updated_at,(select max(m.created_at) from public.messages m where m.conversation_id=c.id) as last_message_at,coalesce((select jsonb_agg(s.resource_id order by s.selected_at) from public.conversation_resource_selections s where s.conversation_id=c.id),'[]'::jsonb) as selected_resource_ids from public.conversations c where c.workspace_id=target_workspace_id order by c.updated_at desc limit 250)x),
    'integrations',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.created_at desc),'[]'::jsonb) from (select ic.id,ic.provider,ic.external_account_id,ic.status,ic.created_at,coalesce((select jsonb_object_agg(cap.capability,cap.granted) from internal.integration_capabilities cap where cap.connection_id=ic.id),'{}'::jsonb) as capabilities from internal.integration_connections ic where ic.organization_id=org_id)x),
    'available_resources',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.display_name),'[]'::jsonb) from (select ir.id,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,ir.resource_status as status,ic.status as connection_status,coalesce((select jsonb_agg(cap.capability order by cap.capability) from internal.integration_capabilities cap where cap.connection_id=ir.connection_id and cap.granted),'[]'::jsonb) as provider_capabilities from internal.integration_resources ir join internal.integration_connections ic on ic.id=ir.connection_id where ic.organization_id=org_id and ir.resource_status='available')x),
    'project_resources',(select coalesce(jsonb_agg(row_to_json(x) order by x.project_id,x.provider,x.display_name),'[]'::jsonb) from (select pir.project_id,pir.resource_id,pir.enabled,ir.connection_id,ic.provider,ir.resource_type,ir.external_id as external_resource_id,coalesce(ir.display_name,ir.external_id) as display_name,ir.metadata,coalesce((select jsonb_agg(g.capability order by g.capability) from public.integration_resource_grants g where g.project_id=pir.project_id and g.resource_id=pir.resource_id and g.granted),'[]'::jsonb) as capabilities from public.project_integration_resources pir join public.projects p on p.id=pir.project_id join internal.integration_resources ir on ir.id=pir.resource_id join internal.integration_connections ic on ic.id=ir.connection_id where p.workspace_id=target_workspace_id)x),
    'resource_links',(select coalesce(jsonb_agg(row_to_json(x) order by x.updated_at desc),'[]'::jsonb) from (select l.id,l.project_id,l.resource_a_id,l.resource_b_id,l.relation_key,l.status,l.confidence,l.source_kind,l.note,l.updated_at from public.project_resource_links l join public.projects p on p.id=l.project_id where p.workspace_id=target_workspace_id)x),
    'capability_catalog',(select coalesce(jsonb_agg(row_to_json(x) order by x.provider,x.capability),'[]'::jsonb) from (select provider,capability,label,risk,resource_type,description from internal.integration_capability_catalog)x)
  );
end $$;

create or replace function public.worker_project_resource_directory(target_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare pid uuid; oid uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select c.project_id,r.organization_id into pid,oid from internal.agent_runs r join public.conversations c on c.id=r.conversation_id where r.id=target_run_id;
  if pid is null then return jsonb_build_object('projectId',null,'resources','[]'::jsonb,'links','[]'::jsonb); end if;
  return jsonb_build_object('projectId',pid,
    'resources',(select coalesce(jsonb_agg(jsonb_build_object('resourceId',ir.id,'provider',ic.provider,'resourceType',ir.resource_type,'externalResourceId',ir.external_id,'displayName',coalesce(ir.display_name,ir.external_id),'capabilities',coalesce((select jsonb_agg(g.capability order by g.capability) from public.integration_resource_grants g where g.project_id=pid and g.resource_id=ir.id and g.granted),'[]'::jsonb)) order by ic.provider,coalesce(ir.display_name,ir.external_id)),'[]'::jsonb) from public.project_integration_resources pir join internal.integration_resources ir on ir.id=pir.resource_id and ir.resource_status='available' join internal.integration_connections ic on ic.id=ir.connection_id and ic.organization_id=oid and ic.status in ('connected','active','ready') where pir.project_id=pid and pir.enabled),
    'links',(select coalesce(jsonb_agg(jsonb_build_object('linkId',l.id,'resourceAId',l.resource_a_id,'resourceBId',l.resource_b_id,'relation',l.relation_key,'status',l.status,'confidence',l.confidence,'source',l.source_kind,'note',l.note) order by l.updated_at desc),'[]'::jsonb) from public.project_resource_links l where l.project_id=pid and l.status<>'rejected')
  );
end $$;

create or replace function public.worker_remember_resource_link(target_run_id uuid,target_resource_one_id uuid,target_resource_two_id uuid,target_relation_key text default 'same_application',target_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pid uuid; oid uuid; actor uuid; a_id uuid; b_id uuid; rel text:=lower(trim(coalesce(target_relation_key,'same_application'))); row_link public.project_resource_links%rowtype;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  select c.project_id,r.organization_id,r.requested_by into pid,oid,actor from internal.agent_runs r join public.conversations c on c.id=r.conversation_id where r.id=target_run_id;
  if pid is null then raise exception 'project_required'; end if;
  if not internal.has_permission_for_user(oid,actor,'integration.manage') or not internal.has_permission_for_user(oid,actor,'project.write') then raise exception 'permission_denied' using errcode='42501'; end if;
  if target_resource_one_id=target_resource_two_id then raise exception 'resource_link_requires_two_resources'; end if;
  if not exists(select 1 from public.project_integration_resources where project_id=pid and resource_id=target_resource_one_id and enabled) or not exists(select 1 from public.project_integration_resources where project_id=pid and resource_id=target_resource_two_id and enabled) then raise exception 'project_resource_not_enabled'; end if;
  if target_resource_one_id::text<target_resource_two_id::text then a_id:=target_resource_one_id;b_id:=target_resource_two_id;else a_id:=target_resource_two_id;b_id:=target_resource_one_id;end if;
  insert into public.project_resource_links(project_id,resource_a_id,resource_b_id,relation_key,status,confidence,source_kind,note,created_by,confirmed_by,updated_at) values(pid,a_id,b_id,rel,'confirmed',1,'agent',nullif(trim(coalesce(target_note,'')),''),actor,actor,now())
  on conflict(project_id,resource_a_id,resource_b_id,relation_key) do update set status='confirmed',confidence=1,source_kind='agent',note=excluded.note,confirmed_by=actor,updated_at=now() returning * into row_link;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values(oid,actor,'integration.resource_link.remembered_by_agent','project_resource_link',row_link.id::text,'success',jsonb_build_object('project_id',pid,'resource_a_id',a_id,'resource_b_id',b_id,'relation',rel));
  return to_jsonb(row_link);
end $$;

revoke all on function public.reconcile_project_resource_links(uuid) from public,anon,authenticated;
grant execute on function public.reconcile_project_resource_links(uuid) to service_role;
revoke all on function public.worker_project_resource_directory(uuid) from public,anon,authenticated;
grant execute on function public.worker_project_resource_directory(uuid) to service_role;
revoke all on function public.worker_remember_resource_link(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.worker_remember_resource_link(uuid,uuid,uuid,text,text) to service_role;
revoke all on function public.conversation_resource_context(uuid) from public,anon;
grant execute on function public.conversation_resource_context(uuid) to authenticated;
