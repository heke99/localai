begin;

-- User projects must remain in the same workspace/mode as every conversation.
-- Hidden standalone projects are intentionally mode-neutral: one hidden project can
-- back standalone Chat/Code/Lab/Research conversations while the API exposes them
-- to the client as project_id = null.
do $$
begin
  if exists (
    select 1
    from public.conversations c
    left join public.projects p on p.id = c.project_id
    where c.project_id is not null
      and (
        p.id is null
        or p.workspace_id is distinct from c.workspace_id
        or (p.system_kind is null and p.mode is distinct from c.mode)
      )
  ) then
    raise exception 'existing_conversation_project_invariant_violation';
  end if;
end $$;

create unique index if not exists projects_id_workspace_unique_idx
  on public.projects(id, workspace_id);

-- Replace the old ON DELETE SET NULL relationship. A conversation must never be
-- silently detached from a project because that changes its security/context model.
alter table public.conversations
  drop constraint if exists conversations_project_id_fkey;
alter table public.conversations
  drop constraint if exists conversations_project_workspace_fk;
alter table public.conversations
  add constraint conversations_project_workspace_fk
  foreign key (project_id, workspace_id)
  references public.projects(id, workspace_id)
  on update restrict
  on delete restrict;

create or replace function internal.enforce_project_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.created_by is distinct from old.created_by
     or new.mode is distinct from old.mode
     or new.system_kind is distinct from old.system_kind then
    raise exception 'project_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.enforce_conversation_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.project_id is distinct from old.project_id
     or new.created_by is distinct from old.created_by
     or new.mode is distinct from old.mode then
    raise exception 'conversation_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.enforce_message_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.conversation_id is distinct from old.conversation_id
     or new.actor_user_id is distinct from old.actor_user_id
     or new.role is distinct from old.role then
    raise exception 'message_identity_is_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_identity_immutable on public.projects;
create trigger projects_identity_immutable
before update on public.projects
for each row execute function internal.enforce_project_identity_immutable();

drop trigger if exists conversations_identity_immutable on public.conversations;
create trigger conversations_identity_immutable
before update on public.conversations
for each row execute function internal.enforce_conversation_identity_immutable();

drop trigger if exists messages_identity_immutable on public.messages;
create trigger messages_identity_immutable
before update on public.messages
for each row execute function internal.enforce_message_identity_immutable();

revoke all on function internal.enforce_project_identity_immutable() from public, anon, authenticated;
revoke all on function internal.enforce_conversation_identity_immutable() from public, anon, authenticated;
revoke all on function internal.enforce_message_identity_immutable() from public, anon, authenticated;
grant execute on function internal.enforce_project_identity_immutable() to service_role;
grant execute on function internal.enforce_conversation_identity_immutable() to service_role;
grant execute on function internal.enforce_message_identity_immutable() to service_role;

commit;
