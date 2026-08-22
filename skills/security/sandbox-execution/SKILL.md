---
name: sandbox-execution
description: Use whenever LocalAI executes generated or untrusted code, shell commands, repository tooling, security tools or document-processing binaries.
metadata: {version: "1.0.0", category: security, risk: high}
---
# Sandbox Execution

## When to Use
Shell/code execution, builds, tests, package installation, pentest tools, parsers and any untrusted executable workload.

## When NOT to Use
Pure read-only reasoning with no execution.

## Inputs
Command/workload, filesystem scope, CPU/RAM/time budget, network policy, credentials and expected artifacts.

## Workflow
1. Create disposable isolated worker with non-root identity where possible.
2. Mount only required files; default filesystem access to deny outside workspace.
3. Apply CPU, memory, process-count, disk and execution-time limits.
4. Apply explicit network-egress policy before start.
5. Inject only scoped short-lived credentials through runtime secret channels, never prompt text.
6. Separate stdout/stderr/artifacts from trusted control messages.
7. Capture exit code, resource usage and file/network mutations.
8. Destroy worker after artifact extraction unless checkpoint policy requires preservation.

## Verification Gate
The execution cannot access resources outside declared filesystem/network/credential scope and produces an auditable result envelope.

## Failure / Rollback
Terminate on resource abuse, policy violation or unexpected network access; discard worker and revoke injected credentials.
