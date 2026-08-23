create table if not exists internal.integration_capability_catalog (
  provider text not null,
  capability text not null,
  label text not null,
  risk text not null check (risk in ('read','write','destructive','sensitive')),
  resource_type text not null,
  description text,
  created_at timestamptz not null default now(),
  primary key (provider, capability)
);

insert into internal.integration_capability_catalog(provider,capability,label,risk,resource_type,description) values
('github','github.repository.read','Read repository','read','repository','Read repository metadata and structure'),
('github','github.contents.read','Read code','read','repository','Read repository files and code'),
('github','github.contents.write','Write code','write','repository','Create and update repository files'),
('github','github.branch.create','Create branches','write','repository','Create branches for agent work'),
('github','github.pull_request.read','Read pull requests','read','repository','Read pull requests and reviews'),
('github','github.pull_request.create','Create pull requests','write','repository','Open and update pull requests'),
('github','github.pull_request.merge','Merge pull requests','destructive','repository','Merge approved pull requests'),
('github','github.actions.read','Read Actions','read','repository','Read workflow runs and logs'),
('github','github.actions.run','Run Actions','write','repository','Dispatch supported workflow runs'),
('github','github.workflow.write','Edit workflows','destructive','repository','Modify workflow definitions'),
('supabase','supabase.project.read','Read project','read','project','Read Supabase project metadata'),
('supabase','supabase.database.read','Read database','read','project','Read schema and query data'),
('supabase','supabase.database.write','Write database','write','project','Execute approved data writes'),
('supabase','supabase.migrations.read','Read migrations','read','project','Inspect migrations and schema history'),
('supabase','supabase.migrations.apply','Apply migrations','destructive','project','Apply schema migrations'),
('supabase','supabase.functions.read','Read Edge Functions','read','project','Inspect Edge Functions'),
('supabase','supabase.functions.write','Write Edge Functions','write','project','Deploy or update Edge Functions'),
('supabase','supabase.auth.read','Read Auth config','read','project','Inspect Auth configuration'),
('supabase','supabase.auth.write','Write Auth config','destructive','project','Modify Auth configuration'),
('supabase','supabase.logs.read','Read logs','read','project','Read runtime and database logs'),
('supabase','supabase.secrets.read','Read secret metadata','sensitive','project','Read secret metadata where provider permits'),
('supabase','supabase.secrets.write','Write secrets','destructive','project','Create or rotate secrets'),
('vercel','vercel.project.read','Read project','read','project','Read Vercel project metadata'),
('vercel','vercel.deployments.read','Read deployments','read','project','Read deployment status and history'),
('vercel','vercel.deployments.create','Create deployments','write','project','Create or redeploy deployments'),
('vercel','vercel.deployments.rollback','Rollback deployment','destructive','project','Rollback to an earlier deployment'),
('vercel','vercel.logs.read','Read logs','read','project','Read build and runtime logs'),
('vercel','vercel.environment.read','Read environment metadata','read','project','Read environment variable names and metadata'),
('vercel','vercel.environment.write','Write environment','destructive','project','Create or update environment variables'),
('vercel','vercel.domains.read','Read domains','read','project','Read project domains'),
('vercel','vercel.domains.write','Write domains','destructive','project','Add or remove project domains')
on conflict (provider,capability) do update set label=excluded.label,risk=excluded.risk,resource_type=excluded.resource_type,description=excluded.description;

-- integration_resources predates this migration. Extend the canonical table rather than creating a second resource model.
alter table internal.integration_resources add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table internal.integration_resources add column if not exists resource_status text not null default 'available';
alter table internal.integration_resources add column if not exists discovered_at timestamptz not null default now();
alter table internal.integration_resources add column if not exists updated_at timestamptz not null default now();
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='internal.integration_resources'::regclass and conname='integration_resources_resource_status_check') then
    alter table internal.integration_resources add constraint integration_resources_resource_status_check check(resource_status in ('available','disabled','removed'));
  end if;
end $$;
create index if not exists integration_resources_connection_status_idx on internal.integration_resources(connection_id,resource_status);

create table if not exists public.project_integration_resources (
  project_id uuid not null references public.projects(id) on delete cascade,
  resource_id uuid not null references internal.integration_resources(id) on delete cascade,
  enabled boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(project_id,resource_id)
);
create index if not exists project_integration_resources_resource_idx on public.project_integration_resources(resource_id,project_id);

create table if not exists public.integration_resource_grants (
  project_id uuid not null,
  resource_id uuid not null,
  capability text not null,
  granted boolean not null default true,
  granted_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(project_id,resource_id,capability),
  foreign key(project_id,resource_id) references public.project_integration_resources(project_id,resource_id) on delete cascade
);
create index if not exists integration_resource_grants_resource_idx on public.integration_resource_grants(resource_id,project_id,granted);

create table if not exists public.conversation_resource_selections (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  resource_id uuid not null references internal.integration_resources(id) on delete cascade,
  selected_by uuid not null references auth.users(id),
  selected_at timestamptz not null default now(),
  primary key(conversation_id,resource_id)
);
create index if not exists conversation_resource_selections_resource_idx on public.conversation_resource_selections(resource_id,conversation_id);

alter table public.project_integration_resources enable row level security;
alter table public.integration_resource_grants enable row level security;
alter table public.conversation_resource_selections enable row level security;

drop policy if exists project_integration_resources_select on public.project_integration_resources;
create policy project_integration_resources_select on public.project_integration_resources for select to authenticated using (
  exists(select 1 from public.projects p where p.id=project_id and internal.is_workspace_member(p.workspace_id))
);
drop policy if exists integration_resource_grants_select on public.integration_resource_grants;
create policy integration_resource_grants_select on public.integration_resource_grants for select to authenticated using (
  exists(select 1 from public.projects p where p.id=project_id and internal.is_workspace_member(p.workspace_id))
);
drop policy if exists conversation_resource_selections_select on public.conversation_resource_selections;
create policy conversation_resource_selections_select on public.conversation_resource_selections for select to authenticated using (
  exists(select 1 from public.conversations c where c.id=conversation_id and internal.is_workspace_member(c.workspace_id))
);
revoke insert,update,delete on public.project_integration_resources from anon,authenticated;
revoke insert,update,delete on public.integration_resource_grants from anon,authenticated;
revoke insert,update,delete on public.conversation_resource_selections from anon,authenticated;

alter table internal.agent_runs add column if not exists resource_context jsonb not null default '[]'::jsonb;
