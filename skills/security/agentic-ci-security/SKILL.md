---
name: agentic-ci-security
description: Use when GitHub Actions or other CI workflows invoke AI agents, LLMs or coding automation with repository tokens, secrets or write permissions.
metadata: {version: "1.0.0", category: security, risk: high}
---
# Agentic CI Security

## When to Use
Workflows that pass issue/PR/comment/code content into agents or allow agents to commit, comment, merge, deploy or access secrets.

## When NOT to Use
CI with no agent/LLM execution and no equivalent untrusted-code execution path.

## Inputs
Workflow files, reusable/composite actions, event triggers, permissions, secrets and untrusted input sources.

## Workflow
1. Enumerate all agent/LLM invocation paths including nested reusable actions.
2. Identify attacker-controlled values from PRs, issues, comments, branch names, commit messages and repository files.
3. Trace those values into prompts, env vars, shell and agent configuration.
4. Inspect token permissions and whether fork/untrusted events receive privileged credentials.
5. Require sandboxing and restricted egress for agent-executed code.
6. Separate read-only analysis workflows from write/deploy workflows.
7. Pin third-party actions by immutable revision where appropriate.
8. Test representative prompt-injection payloads against the workflow boundary.

## Verification Gate
Untrusted contributor content cannot cause an agent with privileged credentials to exceed the intended workflow action.

## Failure / Rollback
Disable privileged agent workflow or reduce token permissions until the input/authority path is isolated.
