begin;

-- These read RPCs are authenticated product APIs. Later CREATE OR REPLACE
-- migrations restored an explicit anon EXECUTE grant, so lock them back to
-- signed-in callers and service workers only.
revoke all on function public.get_agent_run(uuid) from public, anon;
grant execute on function public.get_agent_run(uuid) to authenticated, service_role;

revoke all on function public.get_agent_run_stream(uuid) from public, anon;
grant execute on function public.get_agent_run_stream(uuid) to authenticated, service_role;

-- Cover the remaining Direct Model foreign-key access paths reported by the
-- production advisor. Conversation/requested_by are already covered by the
-- existing time-ordered indexes in 20260831183000_direct_model_runtime.sql.
-- Keep these as full indexes so both PostgreSQL FK lookups and the production
-- advisor recognize them as unconditional covering indexes.
create index if not exists direct_model_runs_organization_idx
  on internal.direct_model_runs(organization_id);

create index if not exists direct_model_runs_input_message_idx
  on internal.direct_model_runs(input_message_id);

create index if not exists direct_model_runs_output_message_idx
  on internal.direct_model_runs(output_message_id);

commit;
