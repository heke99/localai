---
name: sharp-edges
description: Use to identify APIs, configuration and abstractions that make insecure usage easy or secure usage unusually difficult even when current code is not yet directly vulnerable.
metadata: {version: "1.0.0", category: security, risk: low}
---
# Sharp Edges

## When to Use
API/design review, security hardening, reusable libraries, authentication/crypto/configuration interfaces.

## When NOT to Use
Confirmed exploit remediation where a direct root-cause fix is already known.

## Inputs
Public/internal interfaces, call sites, defaults and common developer usage patterns.

## Workflow
1. Identify security decisions delegated to ordinary callers.
2. Look for boolean flags/string modes that can accidentally disable protections.
3. Find ambiguous APIs where dangerous and safe operations look equally normal.
4. Check whether validation/auth/crypto can be skipped through convenience paths.
5. Review error types for fail-open handling.
6. Propose safer types, constructors, defaults or capability-separated APIs.
7. Search all call sites before changing the abstraction.

## Verification Gate
The safer design makes the intended secure path easier/default and dangerous behavior explicit and reviewable.

## Failure / Rollback
Avoid cosmetic wrappers that hide but do not remove dangerous states.
