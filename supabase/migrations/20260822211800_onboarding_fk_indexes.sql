create index if not exists access_requests_organization_id_idx
  on public.access_requests (organization_id)
  where organization_id is not null;

create index if not exists access_requests_workspace_id_idx
  on public.access_requests (workspace_id)
  where workspace_id is not null;
