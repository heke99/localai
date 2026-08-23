create index if not exists project_resource_links_created_by_idx on public.project_resource_links(created_by) where created_by is not null;
create index if not exists project_resource_links_confirmed_by_idx on public.project_resource_links(confirmed_by) where confirmed_by is not null;
create index if not exists project_resource_links_project_b_fk_idx on public.project_resource_links(project_id,resource_b_id);
create index if not exists conversation_resource_selections_selected_by_idx on public.conversation_resource_selections(selected_by);
create index if not exists integration_resource_grants_granted_by_idx on public.integration_resource_grants(granted_by);
create index if not exists project_integration_resources_created_by_idx on public.project_integration_resources(created_by);
