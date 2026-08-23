-- New SECURITY DEFINER overloads receive EXECUTE for Postgres PUBLIC by default.
-- Keep project creation authenticated-only on both overloads.
revoke execute on function public.create_project(uuid,text,text,text) from public, anon;
grant execute on function public.create_project(uuid,text,text,text) to authenticated;

revoke execute on function public.create_project(uuid,text,text) from public, anon;
grant execute on function public.create_project(uuid,text,text) to authenticated;
