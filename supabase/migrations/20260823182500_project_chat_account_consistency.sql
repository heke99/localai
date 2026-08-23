begin;

-- Project/chat identity is immutable after creation. A conversation belongs to
-- exactly one physical project/workspace/mode for its full lifetime. Standalone
-- chats continue to use the hidden standalone project internally.

do $$
begin
  if exists (
    select 1
    from public.conversations c
    left join public.projects p on p.id = c.project_id
    where c.project_id is not null
      and (p.id is null or p.workspace_id is distinct from c.workspace_id or p.mode is distinct from c.mode)
  ) then
    raise exception 'existing_conversation_project_invariant_violation';
  end if;
end $$;

create unique index if not exists projects_id_workspace_unique_idx
  on public.projects(id, workspace_id);

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

-- Reversible account pause is separate from organization suspension. It blocks
-- ordinary workspace/org access without destroying memberships, so resume is
-- deterministic and does not reconstruct permissions from guesses.
alter table public.profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists account_paused_at timestamptz,
  add column if not exists account_status_changed_at timestamptz not null default now();

alter table public.profiles drop constraint if exists profiles_account_status_check;
alter table public.profiles add constraint profiles_account_status_check
  check (account_status in ('active','paused'));

alter table public.profiles drop constraint if exists profiles_account_pause_timestamp_check;
alter table public.profiles add constraint profiles_account_pause_timestamp_check
  check (
    (account_status = 'active' and account_paused_at is null)
    or (account_status = 'paused' and account_paused_at is not null)
  );

create or replace function internal.is_account_active(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin()
    or exists (
      select 1
      from public.profiles p
      where p.user_id = target_user_id
        and p.account_status = 'active'
    )
$$;

create or replace function internal.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin()
    or (
      internal.is_account_active((select auth.uid()))
      and exists (
        select 1
        from public.organization_members m
        where m.organization_id = org_id
          and m.user_id = (select auth.uid())
          and m.status = 'active'
      )
    )
$$;

create or replace function internal.is_workspace_member(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select internal.is_superadmin()
    or (
      internal.is_account_active((select auth.uid()))
      and exists (
        select 1
        from public.workspace_members m
        where m.workspace_id = ws_id
          and m.user_id = (select auth.uid())
      )
    )
$$;

revoke all on function internal.is_account_active(uuid) from public, anon;
grant execute on function internal.is_account_active(uuid) to authenticated, service_role;

create or replace function public.set_my_account_status(target_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  normalized_status text := lower(trim(coalesce(target_status, '')));
  current_status text;
  changed boolean := false;
begin
  if actor_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if normalized_status not in ('active','paused') then
    raise exception 'account_status_not_allowed';
  end if;
  if internal.is_superadmin() and normalized_status = 'paused' then
    raise exception 'superadmin_account_pause_not_allowed' using errcode = '42501';
  end if;

  select p.account_status into current_status
  from public.profiles p
  where p.user_id = actor_id
  for update;

  if current_status is null then
    raise exception 'profile_not_found';
  end if;

  if current_status is distinct from normalized_status then
    update public.profiles
    set account_status = normalized_status,
        account_paused_at = case when normalized_status = 'paused' then now() else null end,
        account_status_changed_at = now(),
        updated_at = now()
    where user_id = actor_id;
    changed := true;

    insert into audit.audit_events(
      actor_user_id, event_type, target_type, target_id, outcome, metadata_redacted
    ) values (
      actor_id,
      case when normalized_status = 'paused' then 'account.paused' else 'account.resumed' end,
      'user', actor_id::text, 'completed',
      jsonb_build_object('previousStatus', current_status, 'newStatus', normalized_status)
    );
  end if;

  return jsonb_build_object(
    'status', normalized_status,
    'changed', changed,
    'pausedAt', (
      select p.account_paused_at from public.profiles p where p.user_id = actor_id
    )
  );
end;
$$;

revoke all on function public.set_my_account_status(text) from public, anon;
grant execute on function public.set_my_account_status(text) to authenticated;

-- Authenticated users may edit only benign profile presentation fields directly.
-- Lifecycle fields are writable only through the state-machine RPC above.
revoke update on public.profiles from authenticated;
grant update(display_name, avatar_path) on public.profiles to authenticated;

commit;
