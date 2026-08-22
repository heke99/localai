---
name: supabase-postgres
description: Use for Supabase/Postgres schema, migrations, RLS, Auth data access, query performance, indexes, generated types and database-runtime consistency.
metadata: {version: "1.0.0", category: platform, risk: high}
---
# Supabase & Postgres

## When to Use
Schema changes, SQL/RPC, RLS, indexes, migrations, Supabase Auth integration, connection/query performance, generated database types or production parity work.

## When NOT to Use
Frontend-only work that does not depend on database behavior.

## Inputs
Current migration chain, schema/types, target query/flow, tenant model, expected cardinality, existing policies and runtime callers.

## Workflow
1. Treat migrations as the canonical schema history; do not hand-edit generated types as a substitute for schema changes.
2. Inspect table keys, foreign keys, nullability, uniqueness and ownership before changing callers.
3. Model tenant isolation explicitly and review every affected RLS policy for SELECT/INSERT/UPDATE/DELETE behavior.
4. Ensure privileged service-role paths are server-only and audited.
5. For query performance, capture real query shape and use `EXPLAIN (ANALYZE, BUFFERS)` in a safe environment when possible.
6. Add indexes for demonstrated access patterns, considering selectivity, write cost and composite ordering; avoid index-by-guessing.
7. Design migrations to be deterministic, replayable and safe from a clean database.
8. Handle backfills separately from schema locks when volume can be large.
9. Regenerate canonical Supabase TypeScript types and any schema manifests after migrations.
10. Test from a clean migration replay plus authenticated tenant scenarios.

## Verification Gate
Clean replay succeeds, RLS behavior is proven for allowed and denied actors, generated artifacts match the migration tail, and performance claims have query-plan evidence.

## Failure / Rollback
Do not disable RLS or integrity checks to make CI pass. For risky production migrations, use expand/migrate/contract or another rollback-compatible sequence.

## Rationalizations to Reject
- "The service role makes RLS irrelevant." It only bypasses enforcement in that privileged path; tenant-facing paths still require correct policy design.
- "An index is always faster." Unused or low-selectivity indexes can increase writes and planner complexity.
- "Generated types can be fixed manually." They must be regenerated from the canonical schema.
