begin;

drop function if exists public.bootstrap_initial_superadmin_from_email(text,text);
drop function if exists public.bootstrap_initial_superadmin(text,uuid,text);
drop table if exists internal.bootstrap_tokens;

commit;
