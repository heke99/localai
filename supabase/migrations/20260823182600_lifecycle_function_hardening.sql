begin;

-- Trigger helpers are internal implementation details. Keep them inaccessible as
-- callable application functions even though PostgreSQL only invokes them via triggers.
revoke all on function internal.enforce_project_identity_immutable() from public, anon, authenticated;
revoke all on function internal.enforce_conversation_identity_immutable() from public, anon, authenticated;
revoke all on function internal.enforce_message_identity_immutable() from public, anon, authenticated;
grant execute on function internal.enforce_project_identity_immutable() to service_role;
grant execute on function internal.enforce_conversation_identity_immutable() to service_role;
grant execute on function internal.enforce_message_identity_immutable() to service_role;

-- Membership helpers are policy primitives. They may be evaluated by authenticated
-- requests and the service role, but never by anon.
revoke all on function internal.is_org_member(uuid) from public, anon;
revoke all on function internal.is_workspace_member(uuid) from public, anon;
grant execute on function internal.is_org_member(uuid) to authenticated, service_role;
grant execute on function internal.is_workspace_member(uuid) to authenticated, service_role;

-- Billing lifecycle RPCs are intentionally narrow: customers can request and read;
-- only service-role provider adapters may confirm provider state.
revoke all on function public.my_subscription_snapshot(uuid) from public, anon;
revoke all on function public.request_my_subscription_action(uuid,text) from public, anon;
grant execute on function public.my_subscription_snapshot(uuid) to authenticated;
grant execute on function public.request_my_subscription_action(uuid,text) to authenticated;

revoke all on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.service_confirm_subscription_status(uuid,text,text,timestamptz,text,text) to service_role;

commit;
