---
name: brainstorming-design
description: Use before building a new feature or materially changing behavior to turn goals and constraints into a small set of viable designs.
metadata: {version: "1.0.0", category: planning, risk: low}
---
# Brainstorming & Design

## When to Use
New product capability, unclear feature, architecture change or multiple plausible approaches.

## When NOT to Use
Well-scoped bug with known desired behavior; use systematic debugging.

## Inputs
Goal, users, constraints, current system, non-goals and success criteria.

## Workflow
1. Inspect existing system facts before inventing architecture.
2. Separate requirements from assumptions.
3. Identify invariants and failure modes.
4. Generate 2-3 materially different approaches.
5. Compare simplicity, reversibility, security, performance and migration cost.
6. Prefer the smallest design satisfying current requirements; avoid speculative complexity.
7. Produce a chosen design with interfaces, data flow, risks and acceptance criteria.

## Verification Gate
The chosen design has explicit tradeoffs, no unresolved contradiction with existing system facts, and testable acceptance criteria.

## Failure / Rollback
If critical facts are unavailable, label assumptions and choose reversible scaffolding instead of irreversible architecture.
