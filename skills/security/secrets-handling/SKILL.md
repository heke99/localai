---
name: secrets-handling
description: Use whenever LocalAI reads, injects, rotates, redacts or transmits API keys, database credentials, tokens, signing keys or other sensitive runtime secrets.
metadata: {version: "1.0.0", category: security, risk: high}
---
# Secrets Handling

## When to Use
Any workflow touching credentials or confidential authentication material.

## When NOT to Use
Public configuration with no secret value.

## Inputs
Secret reference, intended audience/tool, minimum permissions and lifetime.

## Workflow
1. Keep secret values out of model prompts, memory, logs, git and durable artifacts.
2. Resolve secret references server-side after authorization.
3. Prefer short-lived scoped tokens over long-lived master credentials.
4. Inject secrets only into the process/tool that needs them.
5. Redact likely secrets from stdout/stderr/tool returns before model exposure.
6. Prevent cross-tenant secret lookup.
7. Record secret identifier/version usage, never the value.
8. Rotate/revoke after suspected disclosure.

## Verification Gate
The model can complete the task using a secret reference/grant without seeing or persisting the raw secret when the tool architecture permits it.

## Failure / Rollback
On leakage, stop propagation, revoke/rotate affected credential and purge exposed logs/artifacts where feasible.
