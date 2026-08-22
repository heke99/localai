---
name: policy-access-control
description: Use before privileged tool access or mutations to resolve actor, tenant, role, capability grants and policy constraints independently from the model.
metadata: {version: "1.0.0", category: security, risk: high}
---
# Policy & Access Control

## When to Use
Tool execution, data mutation, durable learning, repository/infrastructure access, secrets, security testing or administrative actions.

## When NOT to Use
Read-only reasoning that accesses no protected external resource.

## Inputs
Actor identity, tenant, role, requested capability, resource, environment and product policy version.

## Workflow
1. Authenticate actor and resolve tenant before model/tool routing.
2. Resolve explicit capability grants; never infer permission from prompt wording.
3. Intersect actor grants, tenant policy, resource policy and environment policy.
4. Separate read, write, execute, admin and credential-use capabilities.
5. Produce a short-lived scoped grant for the tool/sandbox rather than exposing broad credentials to the model.
6. Log policy version, decision and resource scope.
7. Re-authorize when scope/resource/environment changes.

## Verification Gate
Every privileged tool call can be traced to a valid actor + scope + capability decision.

## Failure / Rollback
Deny closed when identity or scope cannot be resolved. Revocation must invalidate future grants without requiring model restart.

## Rationalizations to Reject
- "The model is trusted." Models do not own authorization.
- "Superadmin means permanent raw credentials." Administrative authority should still be mediated through scoped execution tokens and audit.
