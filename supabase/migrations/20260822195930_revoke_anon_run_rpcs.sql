begin;

revoke all on function public.start_agent_run(uuid,uuid,text,text,text,text,uuid) from anon;
revoke all on function public.get_agent_run(uuid) from anon;
revoke all on function public.cancel_agent_run(uuid) from anon;

commit;
