---
name: network-egress-control
description: Use when an agent sandbox, tool or model-serving worker needs outbound network access so destinations and protocols remain explicitly scoped and auditable.
metadata: {version: "1.0.0", category: security, risk: high}
---
# Network Egress Control

## When to Use
Package downloads, web research from a sandbox, API calls, browser automation, pentest tooling, callbacks or remote repository access.

## When NOT to Use
Workers that require no outbound traffic; keep egress disabled.

## Inputs
Task, allowed destinations, ports/protocols, DNS policy, credential scope and expected traffic volume.

## Workflow
1. Default deny outbound traffic.
2. Resolve task-specific allowlist by hostname/service, not unrestricted internet access.
3. Block cloud metadata/link-local/private management ranges unless explicitly required.
4. Control DNS and prevent alternate resolver/tunnel bypass where the sandbox supports it.
5. Bind credentials to intended destination/audience where possible.
6. Log destination, bytes, protocol and policy decision without logging secret payloads.
7. Expire rules with the sandbox/run.

## Verification Gate
Unexpected destinations fail closed and expected destinations work without widening the rule to `0.0.0.0/0`.

## Failure / Rollback
Revoke egress and credentials on unexplained callbacks, tunneling behavior or destination drift.
