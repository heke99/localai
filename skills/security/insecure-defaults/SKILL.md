---
name: insecure-defaults
description: Use to find fail-open behavior, default credentials, permissive auth/network/storage settings, debug modes, weak crypto choices and dangerous fallback configuration.
metadata: {version: "1.0.0", category: security, risk: low}
---
# Insecure Defaults Review

## When to Use
Production readiness, configuration audit, new service integration, auth changes or deployment hardening.

## When NOT to Use
Pure algorithmic code with no configuration/default behavior.

## Inputs
Configuration sources, environment handling, startup paths, auth/storage/network defaults and deployment manifests.

## Workflow
1. Enumerate security-relevant settings and fallback values.
2. Determine behavior when variables/config are missing, malformed or unreachable.
3. Flag defaults that disable auth/TLS/RLS/verification, expose debug data or bind broadly.
4. Search for shipped/default credentials and hardcoded secrets.
5. Check whether development convenience settings can reach production.
6. Prefer secure-by-default startup that fails closed for missing critical configuration.
7. Add tests for missing/malformed configuration.

## Verification Gate
Production cannot silently start in a weaker security mode because a critical setting was omitted.

## Failure / Rollback
If compatibility requires a legacy permissive mode, make it explicit, opt-in, observable and time-bounded.
