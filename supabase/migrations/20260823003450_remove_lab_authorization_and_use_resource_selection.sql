drop function if exists public.superadmin_create_lab_authorization(uuid,uuid,text,text,integer);
drop function if exists public.superadmin_revoke_lab_authorization(uuid);

-- Lab is available to approved users through the normal role permission. Provider/resource grants now control what the agent may touch.
create or replace function public.superadmin_control_snapshot()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not internal.is_superadmin_aal2() then raise exception 'superadmin_aal2_required' using errcode='42501'; end if;
  return jsonb_build_object(
    'counts',jsonb_build_object('users',(select count(*) from auth.users),'organizations',(select count(*) from public.organizations),'workspaces',(select count(*) from public.workspaces),'projects',(select count(*) from public.projects),'runs',(select count(*) from internal.agent_runs),'queued_jobs',(select count(*) from internal.job_queue where status in ('queued','running','retrying')),'workers',(select count(*) from internal.gpu_workers),'skills',(select count(*) from internal.skills),'knowledge',(select count(*) from internal.knowledge_sources),'integrations',(select count(*) from internal.integration_connections),'policies',(select count(*) from internal.policy_sets),'evals',(select count(*) from internal.eval_runs)),
    'users',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select u.id,u.email,coalesce(p.display_name,split_part(u.email,'@',1)) as display_name,coalesce(u.raw_app_meta_data->>'system_role','user') as system_role,u.created_at,u.last_sign_in_at,(select count(*) from public.organization_members om where om.user_id=u.id and om.status='active') as active_organizations from auth.users u left join public.profiles p on p.user_id=u.id order by u.created_at desc limit 50)x),
    'organizations',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select o.id,o.name,o.slug,o.created_at,(select count(*) from public.organization_members om where om.organization_id=o.id and om.status='active') as active_members,(select count(*) from public.workspaces w where w.organization_id=o.id) as workspaces from public.organizations o order by o.created_at desc limit 50)x),
    'model_aliases',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select ma.alias,ma.model_version_id,mv.version_key,mv.status,mv.repository,mv.revision,ma.updated_at from internal.model_aliases ma join internal.model_versions mv on mv.id=ma.model_version_id order by ma.alias)x),
    'model_versions',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select mv.id,mv.version_key,mv.status,mv.repository,mv.revision,mv.context_window,mv.capabilities,(select ma.quantization from internal.model_artifacts ma where ma.model_version_id=mv.id order by ma.quantization asc,ma.filename asc limit 1) as quantization,mv.created_at from internal.model_versions mv order by mv.created_at desc limit 30)x),
    'gpu_providers',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select gp.id,gp.key,gp.enabled,(select count(*) from internal.gpu_workers gw where gw.provider_id=gp.id) as workers from internal.gpu_providers gp order by gp.key)x),
    'gpu_workers',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select gw.id,gp.key as provider,gw.external_worker_id,gw.profile,gw.state,gw.last_heartbeat_at,mv.version_key from internal.gpu_workers gw join internal.gpu_providers gp on gp.id=gw.provider_id left join internal.model_versions mv on mv.id=gw.model_version_id order by gw.created_at desc limit 50)x),
    'skills',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select s.key,s.category,s.status,s.active_version,s.created_at from internal.skills s order by s.category,s.key limit 100)x),
    'knowledge',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select ks.id,ks.scope_type,ks.source_type,ks.source_uri,ks.approval_status,ks.created_at from internal.knowledge_sources ks order by ks.created_at desc limit 50)x),
    'integrations',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select ic.id,ic.organization_id,o.name as organization_name,ic.provider,ic.external_account_id,ic.status,ic.created_at from internal.integration_connections ic left join public.organizations o on o.id=ic.organization_id order by ic.created_at desc limit 50)x),
    'policies',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select ps.id,ps.organization_id,o.name as organization_name,ps.key,ps.version,ps.status,ps.created_at,(select count(*) from internal.policy_rules pr where pr.policy_set_id=ps.id) as rules from internal.policy_sets ps left join public.organizations o on o.id=ps.organization_id order by ps.created_at desc limit 50)x),
    'eval_runs',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select er.id,er.status,er.created_at,er.finished_at,mv.version_key from internal.eval_runs er left join internal.model_versions mv on mv.id=er.model_version_id order by er.created_at desc limit 30)x),
    'jobs',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select jq.id,jq.queue,jq.status,jq.priority,jq.attempts,jq.maximum_attempts,jq.last_error_code,jq.created_at,jq.updated_at from internal.job_queue jq order by jq.created_at desc limit 40)x),
    'runs',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select ar.id,ar.mode,ar.status,ar.model_alias,ar.failure_code,ar.active_skill,ar.created_at,ar.started_at,ar.finished_at from internal.agent_runs ar order by ar.created_at desc limit 40)x),
    'usage_monthly',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select um.organization_id,o.name as organization_name,um.usage_month,um.totals from internal.usage_monthly um left join public.organizations o on o.id=um.organization_id order by um.usage_month desc limit 24)x),
    'audit',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select ae.id,ae.event_type,ae.target_type,ae.target_id,ae.outcome,ae.occurred_at,ae.organization_id from audit.audit_events ae order by ae.occurred_at desc limit 50)x),
    'errors',(select coalesce(jsonb_agg(row_to_json(x)),'[]'::jsonb) from (select oe.trace_id,oe.service,oe.event_name,oe.severity,oe.duration_ms,oe.occurred_at from internal.observability_events oe where oe.severity='error' order by oe.occurred_at desc limit 30)x)
  );
end $$;
revoke all on function public.superadmin_control_snapshot() from public,anon;
grant execute on function public.superadmin_control_snapshot() to authenticated;

drop table if exists internal.lab_authorizations;
