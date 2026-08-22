---
name: vercel-operations
description: Use for Vercel project configuration, deployments, runtime logs, environment variables, domains, caching, Next.js production behavior and rollback.
metadata: {version: "1.0.0", category: platform, risk: high}
---
# Vercel Operations

## When to Use
Deployments, production/preview diagnostics, environment configuration, domains, build/runtime failures, function performance or caching behavior.

## When NOT to Use
Local-only implementation with no Vercel-specific effect.

## Inputs
Project/environment, deployment/commit, framework version, target route, runtime logs/metrics and env dependency list.

## Workflow
1. Resolve the exact Vercel project and environment before mutation.
2. Map deployment to Git commit; avoid debugging the wrong artifact.
3. Inspect build output and runtime logs separately.
4. For env changes, compare required names/scopes without exposing secret values.
5. Diagnose performance from metrics and route behavior before changing caching.
6. For Next.js, distinguish static, dynamic, server component, route handler, middleware and client-side work.
7. Apply caching/revalidation only where data-consistency semantics permit it.
8. Deploy preview/canary first when the change is risky or rollback-sensitive.
9. Verify real HTTP/runtime behavior, console/network errors and key flows after deployment.
10. Keep a known-good deployment reference for rollback.

## Verification Gate
The claimed deployment points to the intended commit and key production behavior is verified on the deployed environment, not just by a local build.

## Failure / Rollback
Rollback to the last known-good deployment when a production regression cannot be safely fixed immediately; never rotate/delete env values merely to silence an error without proving the dependency.
