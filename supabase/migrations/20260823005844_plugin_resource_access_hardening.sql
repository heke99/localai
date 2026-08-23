revoke all on table public.project_resource_links from anon;
revoke all on table public.project_integration_resources from anon;
revoke all on table public.integration_resource_grants from anon;
revoke all on table public.conversation_resource_selections from anon;
grant select on table public.project_resource_links to authenticated;
grant select on table public.project_integration_resources to authenticated;
grant select on table public.integration_resource_grants to authenticated;
grant select on table public.conversation_resource_selections to authenticated;
