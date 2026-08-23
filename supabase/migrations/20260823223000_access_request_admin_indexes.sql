begin;

-- Supports the superadmin application queue and keeps FK maintenance efficient.
create index if not exists access_requests_status_created_at_idx
  on public.access_requests (status, created_at desc);

create index if not exists access_requests_reviewed_by_idx
  on public.access_requests (reviewed_by)
  where reviewed_by is not null;

commit;
