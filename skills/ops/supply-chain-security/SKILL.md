---
name: supply-chain-security
description: Use when adding or updating packages, containers, models, datasets, skills, GitHub Actions or other third-party artifacts that can execute or influence LocalAI.
metadata: {version: "1.0.0", category: ops, risk: high}
---
# Supply Chain Security

## When to Use
Dependency install/upgrade, external skill import, model download, container/runtime update, action/plugin addition or dataset acquisition.

## When NOT to Use
First-party source change with no new external artifact.

## Inputs
Artifact source, immutable version/revision, checksum/signature, license, transitive dependencies and intended execution privileges.

## Workflow
1. Prefer official/known publishers and primary repositories.
2. Pin immutable revision/checksum where supported.
3. Verify license and provenance before import.
4. Inspect install/build scripts, hooks, bundled binaries and network behavior.
5. Generate/retain dependency or SBOM metadata for runtime artifacts.
6. Scan for known vulnerabilities but do not treat scanner silence as trust.
7. Run external skills/code in an evaluation sandbox before trusted use.
8. Evaluate prompt/tool behavior for skill dependencies, not only filesystem malware.
9. Roll out dependency/model/runtime changes through canary when blast radius is meaningful.
10. Keep rollback artifact/version available.

## Verification Gate
The exact artifact promoted to runtime is identifiable by immutable version/checksum and has passed the relevant functional/security evals.

## Failure / Rollback
Quarantine artifact on provenance mismatch, unexpected hooks/network activity or behavior regression; revert to pinned known-good version.
