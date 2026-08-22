---
name: memory-learning
description: Use when converting approved interactions, outcomes or knowledge into durable memory that improves future agent behavior without coupling it to model weights.
metadata: {version: "1.0.0", category: knowledge, risk: high}
---
# Memory & Learning

## When to Use
Persisting approved preferences, project facts, successful procedures, tool outcomes or reusable learned patterns.

## When NOT to Use
Automatically storing every conversation, secret, transient result or unverified external claim.

## Inputs
Memory candidate, provenance, owner/scope, confidence, sensitivity, retention and approval signal.

## Workflow
1. Classify candidate as semantic fact, procedural memory, episodic run record or preference/configuration.
2. Require provenance and actor/tenant ownership.
3. Redact or reject secrets and unnecessary sensitive data.
4. Score confidence and freshness; attach expiry/revalidation rules where facts can change.
5. Detect conflicts with existing memory and preserve both versions until resolved.
6. Store compact canonical memory plus links to supporting evidence, not raw context dumps.
7. Retrieve by scope + relevance + recency + trust, not embedding similarity alone.
8. Record whether retrieved memory materially affected an action so evals can measure usefulness.
9. Allow explicit correction, supersession and deletion.
10. Promote repeated high-quality procedural outcomes to training-data candidates only through a separate curated pipeline.

## Verification Gate
Memory can be retrieved only in its allowed scope, cites provenance internally, and a correction/supersession test changes future retrieval predictably.

## Failure / Rollback
Disable or delete poisoned memory records by ID/source without changing model weights; rebuild embeddings from canonical records when needed.
