---
name: skill-authoring
description: Use when creating, changing, reviewing or evaluating a LocalAI Agent Skills-compatible skill.
metadata: {version: "1.0.0", category: meta, risk: low}
---
# Skill Authoring

## When to Use
New skill, trigger rewrite, workflow change, bundled script/reference change or upstream import.

## When NOT to Use
General application coding that does not alter skill behavior.

## Inputs
Target capability, baseline agent behavior, risky shortcuts, required tools and expected outputs.

## Workflow
1. Define a narrow job and concrete activation description.
2. Create pressure/eval cases before finalizing instructions: normal, ambiguous, tool failure, shortcut pressure, hostile retrieved content.
3. Observe baseline failures.
4. Write the smallest instructions that close those failures.
5. Include When to Use / NOT Use, inputs, workflow, verification and rollback.
6. For risky skills, add rationalizations to reject.
7. Keep detail in one-level references when the core file grows.
8. Re-run behavior evals and mutation tests of the skill.
9. Version the skill when behavior changes.

## Verification Gate
The skill must improve measured compliance over baseline without causing broad false activation.

## Failure / Rollback
Revert trigger/workflow changes that regress routing or evals; never promote an unevaluated external skill directly to trusted runtime.
