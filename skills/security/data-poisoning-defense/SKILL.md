---
name: data-poisoning-defense
description: Use when ingesting, updating or training from external data so malicious, corrupted, duplicated or contradictory information cannot silently become trusted memory or training data.
metadata: {version: "1.0.0", category: security, risk: high}
---
# Data Poisoning Defense

## When to Use
RAG ingestion, durable memory updates, dataset creation, preference learning, supervised fine-tuning/LoRA data preparation and automated feedback loops.

## When NOT to Use
Ephemeral content used only in one isolated read-only answer.

## Inputs
Source corpus, provenance, trust tier, tenant scope, current canonical knowledge and intended downstream use.

## Workflow
1. Hash/version every source and preserve provenance.
2. Separate raw, normalized, candidate, approved and revoked states.
3. Scan for prompt injection, anomalous instruction density, malware/executables, secrets and data-format abuse.
4. Deduplicate to prevent one source being overweighted through copies.
5. Detect conflicts/outliers against multiple independent trusted sources where factuality matters.
6. Prevent one user/tenant from modifying global knowledge without explicit promotion authority.
7. Keep training-data approval stricter than retrieval-memory approval.
8. Maintain source-to-chunk-to-training-example lineage for rollback.
9. Evaluate model/retrieval behavior before and after promotion.

## Verification Gate
Every promoted record/example is attributable, reversible and within its intended scope; poisoning test cases cannot cross the trust boundary.

## Failure / Rollback
Revoke by source lineage, rebuild affected indexes/datasets and re-run regression evals.
