begin;

create or replace function public.superadmin_set_membership_status(
  target_organization_id uuid,
  target_user_id uuid,
  target_status text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  restored_access text;
begin
  if not internal.is_superadmin_aal2() then
    raise exception 'superadmin_aal2_required' using errcode = '42501';
  end if;
  if target_status not in ('active','suspended') then raise exception 'membership_status_not_allowed'; end if;
  if target_user_id = auth.uid() then raise exception 'cannot_change_own_superadmin_membership'; end if;
  if exists (select 1 from auth.users u where u.id=target_user_id and coalesce(u.raw_app_meta_data->>'system_role','')='superadmin') then
    raise exception 'cannot_change_superadmin_membership';
  end if;
  if not exists (select 1 from public.organization_members om where om.organization_id=target_organization_id and om.user_id=target_user_id) then
    raise exception 'organization_membership_not_found';
  end if;

  update public.organization_members
  set status = target_status::public.membership_status,
      joined_at = case when target_status='active' then coalesce(joined_at,now()) else joined_at end
  where organization_id=target_organization_id and user_id=target_user_id;

  if target_status='suspended' then
    delete from public.workspace_members wm
    using public.workspaces w
    where wm.workspace_id=w.id and w.organization_id=target_organization_id and wm.user_id=target_user_id;
  else
    select case when exists (
      select 1 from public.user_roles ur join public.roles r on r.id=ur.role_id
      where ur.organization_id=target_organization_id and ur.user_id=target_user_id and r.key='organization_admin'
    ) then 'admin' else 'member' end into restored_access;

    insert into public.workspace_members(workspace_id,user_id,access_level)
    select w.id,target_user_id,restored_access from public.workspaces w where w.organization_id=target_organization_id
    on conflict (workspace_id,user_id) do update set access_level=excluded.access_level;
  end if;

  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (target_organization_id,auth.uid(),'membership.status.changed','user',target_user_id::text,'completed',jsonb_build_object('status',target_status));
  return true;
end;
$$;

create or replace function public.superadmin_create_policy_set(
  target_organization_id uuid,
  target_key text,
  target_effect text,
  target_action text,
  target_resource_pattern text,
  target_conditions jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_id uuid;
  next_version integer;
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode='42501'; end if;
  if target_organization_id is not null and not exists (select 1 from public.organizations o where o.id=target_organization_id) then raise exception 'organization_not_found'; end if;
  if target_key !~ '^[a-z0-9][a-z0-9._-]{1,79}$' then raise exception 'invalid_policy_key'; end if;
  if target_effect not in ('allow','deny') then raise exception 'invalid_policy_effect'; end if;
  if length(trim(target_action)) < 1 or length(target_action) > 160 then raise exception 'invalid_policy_action'; end if;
  if length(trim(target_resource_pattern)) < 1 or length(target_resource_pattern) > 1024 then raise exception 'invalid_policy_resource'; end if;
  if target_conditions is null or jsonb_typeof(target_conditions) <> 'object' then raise exception 'invalid_policy_conditions'; end if;

  select coalesce(max(ps.version),0)+1 into next_version
  from internal.policy_sets ps
  where ps.organization_id is not distinct from target_organization_id and ps.key=target_key;

  insert into internal.policy_sets(organization_id,key,version,status,created_by)
  values (target_organization_id,target_key,next_version,'draft',auth.uid())
  returning id into created_id;

  insert into internal.policy_rules(policy_set_id,priority,effect,action,resource_pattern,conditions)
  values (created_id,100,target_effect,trim(target_action),trim(target_resource_pattern),target_conditions);

  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (target_organization_id,auth.uid(),'policy.created','policy_set',created_id::text,'completed',jsonb_build_object('key',target_key,'version',next_version,'effect',target_effect));
  return created_id;
end;
$$;

create or replace function public.superadmin_set_policy_status(
  target_policy_set_id uuid,
  target_status text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare target_org_id uuid;
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode='42501'; end if;
  if target_status not in ('draft','registered','verified','production','retired') then raise exception 'policy_status_not_allowed'; end if;
  select organization_id into target_org_id from internal.policy_sets where id=target_policy_set_id;
  if not found then raise exception 'policy_set_not_found'; end if;
  update internal.policy_sets set status=target_status::internal.lifecycle_status where id=target_policy_set_id;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (target_org_id,auth.uid(),'policy.status.changed','policy_set',target_policy_set_id::text,'completed',jsonb_build_object('status',target_status));
  return true;
end;
$$;

create or replace function public.superadmin_revoke_lab_authorization(target_authorization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare target_org_id uuid;
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode='42501'; end if;
  update internal.lab_authorizations
  set revoked_at=coalesce(revoked_at,now())
  where id=target_authorization_id
  returning organization_id into target_org_id;
  if target_org_id is null then raise exception 'lab_authorization_not_found'; end if;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (target_org_id,auth.uid(),'lab.authorization.revoked','lab_authorization',target_authorization_id::text,'completed','{}'::jsonb);
  return true;
end;
$$;

create or replace function public.superadmin_set_gpu_provider_enabled(target_provider_id uuid,target_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare provider_key text;
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode='42501'; end if;
  update internal.gpu_providers set enabled=target_enabled where id=target_provider_id returning key into provider_key;
  if provider_key is null then raise exception 'gpu_provider_not_found'; end if;
  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (auth.uid(),'gpu.provider.changed','gpu_provider',target_provider_id::text,'completed',jsonb_build_object('provider',provider_key,'enabled',target_enabled));
  return true;
end;
$$;

create or replace function public.superadmin_enqueue_operation(target_queue text, operation_payload jsonb, operation_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare created_id uuid;
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode = '42501'; end if;
  if target_queue not in ('knowledge-ingestion','repository-index','eval','training','gpu-reconcile','rollback','skill-sync') then raise exception 'operation_queue_not_allowed'; end if;
  if operation_payload is null or jsonb_typeof(operation_payload) <> 'object' then raise exception 'operation_payload_invalid'; end if;
  insert into internal.job_queue(queue,payload,dedupe_key) values (target_queue,operation_payload,operation_key)
  on conflict (queue,dedupe_key) do update set payload=excluded.payload returning id into created_id;
  insert into audit.audit_events(actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted)
  values (auth.uid(),'operation.enqueued','job',created_id::text,'completed',jsonb_build_object('queue',target_queue));
  return created_id;
end;
$$;

revoke all on function public.superadmin_set_membership_status(uuid,uuid,text), public.superadmin_create_policy_set(uuid,text,text,text,text,jsonb), public.superadmin_set_policy_status(uuid,text), public.superadmin_revoke_lab_authorization(uuid), public.superadmin_set_gpu_provider_enabled(uuid,boolean) from public, anon;
grant execute on function public.superadmin_set_membership_status(uuid,uuid,text), public.superadmin_create_policy_set(uuid,text,text,text,text,jsonb), public.superadmin_set_policy_status(uuid,text), public.superadmin_revoke_lab_authorization(uuid), public.superadmin_set_gpu_provider_enabled(uuid,boolean) to authenticated, service_role;

commit;
