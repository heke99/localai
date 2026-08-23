begin;

-- Public application writes must only go through the validated Next.js server route.
-- This removes direct browser/PostgREST INSERT access while preserving superadmin review access.
drop policy if exists access_requests_anon_insert on public.access_requests;
revoke insert on public.access_requests from anon, authenticated;

drop function if exists public.submit_access_request(text, text, text, text);

commit;
