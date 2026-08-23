create table if not exists internal.integration_resource_identifiers (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references internal.integration_resources(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  normalized_value text not null,
  display_value text,
  source_kind text not null check (source_kind in ('provider','discovered','user','agent')),
  confidence numeric not null default 1 check (confidence >= 0 and confidence <= 1),
  linkable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(resource_id,kind,normalized_value)
);
alter table internal.integration_resource_identifiers enable row level security;
create index if not exists integration_resource_identifiers_match_idx on internal.integration_resource_identifiers(kind,normalized_value) where linkable;

create table if not exists public.project_resource_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_a_id uuid not null,
  resource_b_id uuid not null,
  relation_key text not null default 'same_application' check (relation_key ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  status text not null default 'suggested' check (status in ('suggested','confirmed','rejected')),
  confidence numeric not null default 1 check (confidence >= 0 and confidence <= 1),
  source_kind text not null check (source_kind in ('provider','inferred','user','agent')),
  note text check (note is null or length(note) <= 2000),
  created_by uuid references auth.users(id) on delete set null,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (resource_a_id <> resource_b_id),
  check (resource_a_id::text < resource_b_id::text),
  foreign key(project_id,resource_a_id) references public.project_integration_resources(project_id,resource_id) on delete cascade,
  foreign key(project_id,resource_b_id) references public.project_integration_resources(project_id,resource_id) on delete cascade,
  unique(project_id,resource_a_id,resource_b_id,relation_key)
);
alter table public.project_resource_links enable row level security;
create index if not exists project_resource_links_project_idx on public.project_resource_links(project_id,status);
create index if not exists project_resource_links_a_idx on public.project_resource_links(resource_a_id,project_id,status);
create index if not exists project_resource_links_b_idx on public.project_resource_links(resource_b_id,project_id,status);
drop policy if exists project_resource_links_select on public.project_resource_links;
create policy project_resource_links_select on public.project_resource_links for select to authenticated using (exists(select 1 from public.projects p where p.id=project_id and internal.is_workspace_member(p.workspace_id)));

grant select on public.project_resource_links to authenticated;

create or replace function public.sync_integration_resource_identifier(target_resource_id uuid,target_kind text,target_value text,target_source_kind text default 'provider',target_confidence numeric default 1,target_linkable boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare k text:=lower(trim(coalesce(target_kind,''))); normalized text; result_id uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if k !~ '^[a-z0-9][a-z0-9._-]{1,79}$' then raise exception 'invalid_identifier_kind'; end if;
  if target_source_kind not in ('provider','discovered','user','agent') then raise exception 'invalid_identifier_source'; end if;
  if target_confidence<0 or target_confidence>1 then raise exception 'invalid_identifier_confidence'; end if;
  normalized:=lower(regexp_replace(trim(coalesce(target_value,'')),'[[:space:]]+','','g'));
  if length(normalized)<2 or length(normalized)>1000 then raise exception 'invalid_identifier_value'; end if;
  insert into internal.integration_resource_identifiers(resource_id,kind,normalized_value,display_value,source_kind,confidence,linkable,updated_at)
  values(target_resource_id,k,normalized,left(target_value,1000),target_source_kind,target_confidence,target_linkable,now())
  on conflict(resource_id,kind,normalized_value) do update set display_value=excluded.display_value,source_kind=excluded.source_kind,confidence=greatest(internal.integration_resource_identifiers.confidence,excluded.confidence),linkable=(internal.integration_resource_identifiers.linkable or excluded.linkable),updated_at=now()
  returning id into result_id;
  return result_id;
end $$;

create or replace function public.remember_project_resource_link(target_project_id uuid,target_resource_one_id uuid,target_resource_two_id uuid,target_relation_key text default 'same_application',target_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_id uuid:=auth.uid(); org_id uuid; a_id uuid; b_id uuid; rel text:=lower(trim(coalesce(target_relation_key,'same_application'))); link_row public.project_resource_links%rowtype;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select w.organization_id into org_id from public.projects p join public.workspaces w on w.id=p.workspace_id where p.id=target_project_id and internal.is_workspace_member(p.workspace_id);
  if org_id is null then raise exception 'project_access_denied' using errcode='42501'; end if;
  if not internal.has_permission(org_id,'project.write') or not internal.has_permission(org_id,'integration.manage') then raise exception 'permission_denied' using errcode='42501'; end if;
  if target_resource_one_id=target_resource_two_id then raise exception 'resource_link_requires_two_resources'; end if;
  if rel !~ '^[a-z0-9][a-z0-9._-]{1,79}$' then raise exception 'invalid_relation_key'; end if;
  if target_note is not null and length(target_note)>2000 then raise exception 'resource_link_note_too_long'; end if;
  if not exists(select 1 from public.project_integration_resources where project_id=target_project_id and resource_id=target_resource_one_id and enabled) or not exists(select 1 from public.project_integration_resources where project_id=target_project_id and resource_id=target_resource_two_id and enabled) then raise exception 'project_resource_not_enabled'; end if;
  if target_resource_one_id::text<target_resource_two_id::text then a_id:=target_resource_one_id;b_id:=target_resource_two_id;else a_id:=target_resource_two_id;b_id:=target_resource_one_id;end if;
  insert into public.project_resource_links(project_id,resource_a_id,resource_b_id,relation_key,status,confidence,source_kind,note,created_by,confirmed_by,updated_at)
  values(target_project_id,a_id,b_id,rel,'confirmed',1,'user',nullif(trim(coalesce(target_note,'')),''),actor_id,actor_id,now())
  on conflict(project_id,resource_a_id,resource_b_id,relation_key) do update set status='confirmed',confidence=1,source_kind='user',note=excluded.note,confirmed_by=actor_id,updated_at=now() returning * into link_row;
  insert into audit.audit_events(organization_id,actor_user_id,event_type,target_type,target_id,outcome,metadata_redacted) values(org_id,actor_id,'integration.resource_link.remembered','project_resource_link',link_row.id::text,'success',jsonb_build_object('project_id',target_project_id,'resource_a_id',a_id,'resource_b_id',b_id,'relation',rel));
  return to_jsonb(link_row);
end $$;

create or replace function public.set_project_resource_link_status(target_link_id uuid,target_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_id uuid:=auth.uid(); org_id uuid; row_link public.project_resource_links%rowtype;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if target_status not in ('confirmed','rejected') then raise exception 'invalid_link_status'; end if;
  select l.* into row_link from public.project_resource_links l join public.projects p on p.id=l.project_id where l.id=target_link_id and internal.is_workspace_member(p.workspace_id);
  if row_link.id is null then raise exception 'resource_link_not_found'; end if;
  select w.organization_id into org_id from public.projects p join public.workspaces w on w.id=p.workspace_id where p.id=row_link.project_id;
  if not internal.has_permission(org_id,'integration.manage') then raise exception 'permission_denied' using errcode='42501'; end if;
  update public.project_resource_links set status=target_status,confirmed_by=case when target_status='confirmed' then actor_id else null end,updated_at=now() where id=target_link_id returning * into row_link;
  return to_jsonb(row_link);
end $$;

create or replace function public.remove_project_resource_link(target_link_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor_id uuid:=auth.uid(); org_id uuid; pid uuid;
begin
  if actor_id is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select l.project_id,w.organization_id into pid,org_id from public.project_resource_links l join public.projects p on p.id=l.project_id join public.workspaces w on w.id=p.workspace_id where l.id=target_link_id and internal.is_workspace_member(p.workspace_id);
  if pid is null then raise exception 'resource_link_not_found'; end if;
  if not internal.has_permission(org_id,'integration.manage') then raise exception 'permission_denied' using errcode='42501'; end if;
  delete from public.project_resource_links where id=target_link_id;
  return true;
end $$;

revoke all on function public.sync_integration_resource_identifier(uuid,text,text,text,numeric,boolean) from public,anon,authenticated;
grant execute on function public.sync_integration_resource_identifier(uuid,text,text,text,numeric,boolean) to service_role;
revoke all on function public.remember_project_resource_link(uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.remember_project_resource_link(uuid,uuid,uuid,text,text) to authenticated;
revoke all on function public.set_project_resource_link_status(uuid,text) from public,anon;
grant execute on function public.set_project_resource_link_status(uuid,text) to authenticated;
revoke all on function public.remove_project_resource_link(uuid) from public,anon;
grant execute on function public.remove_project_resource_link(uuid) to authenticated;
