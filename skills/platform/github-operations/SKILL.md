---
name: github-operations
description: Use when inspecting, changing, committing, pushing, reviewing, merging or diagnosing CI state in a GitHub repository.
metadata: {version: "1.0.0", category: platform, risk: medium}
---
# GitHub Operations

## When to Use
Repository inspection, branch work, commits, pull requests, review iteration, merge, Actions/CI diagnosis or release-state verification.

## When NOT to Use
Pure code reasoning with no repository state or GitHub mutation.

## Inputs
Repository, requested base/head behavior, working-tree/branch state, permissions and required checks.

## Workflow
1. Read repository metadata and current branch/commit before mutation.
2. Preserve unrelated user changes; never stash, reset or overwrite them implicitly.
3. Inspect repository conventions (`AGENTS.md`, contribution docs, workflows) before editing.
4. For code changes, use an isolated branch unless the user explicitly requires direct work on an allowed branch.
5. Keep commits scoped and messages descriptive.
6. Before PR/merge, verify diff, tests and generated artifacts.
7. Inspect required CI checks and actual failing logs rather than guessing from job titles.
8. Patch root cause, rerun the smallest appropriate failed checks, then broader required checks.
9. Merge only when branch head is the expected commit and required gates are satisfied or the actor explicitly accepts known exceptions.
10. Re-read final branch/commit state after push or merge.

## Verification Gate
Requested files are in the intended branch, the remote commit SHA is known, and any claimed merge/CI state is confirmed from GitHub.

## Failure / Rollback
Do not force-update shared branches unless explicitly authorized and necessary. If remote state moved, rebase/reconcile from fresh evidence instead of overwriting it.
