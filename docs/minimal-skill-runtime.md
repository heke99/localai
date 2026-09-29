# Minimal, model-independent runtime skills

## Scope

This change is for `heke99/localai`. It changes which additional instruction files the running worker loads, not the product's answer format or execution permissions. No original skill files, registry entries, model artifacts, database records or history are deleted.

Preserved paths: task/reasoning policy, response integrity and final grounding, tool-result continuation, live-information preflight, streaming, cancellation, history/RAG, tool authorization, security scope, egress and sandbox checks, model adapters, audit and usage. The base instruction bodies and their existing formatting are unchanged.

Skills are portable instruction packages, not model implementations or permission grants. Model/protocol configuration stays in the Model Gateway. The same skill profile can be used with another supported adapter and compatible model without rewriting the skills. This does not mean every model implements reliable tools or has sufficient context: promotion still requires model conformance and runtime evaluation.

## Worker profiles

`services/agent-worker/src/main.ts` explicitly passes trusted configuration to `SkillEngine`. Other library callers that omit runtime options retain their old behavior.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DIV3RSA_SKILL_PROFILE` | `minimal` | `minimal` or `legacy`; unknown values fail startup. |
| `DIV3RSA_SKILL_ADDITIONAL` | empty | Comma-separated, registered local skills deliberately enabled by the operator. Dependencies, modes and conflicts still apply. |
| `DIV3RSA_SKILL_EXTERNAL_ENABLED` | `false` in minimal; `true` in legacy | Controls external security instruction loading, not security tools or authorization. |
| `DIV3RSA_SKILL_MAX_COUNT` | 12 in minimal; 64 in legacy | Maximum selected skill count including dependencies and loaded external skills. |
| `DIV3RSA_SKILL_MAX_INSTRUCTION_CHARS` | 32000 in minimal; 256000 in legacy | Maximum instruction string length including headings/separators. This is UTF-16 code units, NOT tokens or the total prompt budget. |

Configuration is captured when the worker starts. User prompts and tool results cannot change it. Invalid configuration, missing explicitly enabled skills, dependency cycles and conflicts fail rather than silently degrading execution.

### Minimal selection

The current registry's default sets are retained:

- Chat: using-skills, reasoning-router, verification-before-completion (3).
- Code: Chat plus writing-plans and test-driven-development (5).
- Research: Chat plus web-research and current-information-research (5).
- Lab: Chat plus authorized-pentest and its policy-access-control, sandbox-execution and network-egress-control dependencies (7).

Current-information signals still add current-information-research in other modes. The worker's existing live-data preflight is unchanged. Mentioning `model`, `gpu`, `q8`, `database` or `benchmark` no longer automatically pulls in operations, planning or specialist packs in minimal mode. Explicit operator opt-ins are available one at a time. No new skill-specific model bindings are introduced.

External security packs are not read or auto-discovered in the minimal default, even if an external index is installed. They remain installed for a deliberate later experiment. The built-in scoped security tools stay available under their existing authorization and executor-readiness conditions.

### Budgets and telemetry

Selection count is checked after dependency expansion and before reading bodies. Integrity hashes are verified before use. The complete formatted instruction block is checked after reading and again after adding external skills. A budget violation raises `skill_count_budget_exceeded` or `skill_instruction_budget_exceeded`; instructions are never silently cut and required dependencies are never dropped.

Worker `skill-runtime` structured logs contain profile, mode, selected names/count, instruction characters/bytes and the external-loading flag. They do not contain prompts, bodies or credentials. These measurements cover skill instructions only, before the knowledge wrapper; retrieved history, tool schemas, system instructions and RAG require their own accounting. Existing run-intelligence records still record the selected names.

## Verification before rollout

Verify the shipped runtime manifest before starting the worker. After a deliberate skill change, regenerate it and commit the artifact with that change:

```bash
npm run build:skill-manifest
npm run validate:skill-manifest
npm run verify
```

The manifest at base `a2c521d02f6847797b2dc4b944e2c7489feae581` contained 40 entries and omitted `reasoning-router`, among others. Worker startup reproduced `unknown_skill:reasoning-router` in all four modes. The shipped artifact is now synchronized with all 43 registered skills. This does not activate all of them: selection remains 3/5/7/5 in minimal mode. Both CI paths check for manifest drift before regeneration, and the worker checks required dependencies before claiming jobs. This is not a claim about which artifact an existing GPU host is running.

The new regression suite is `packages/skill-engine/src/runtime-profile.test.ts`. It covers selection, freshness, preserved Lab prerequisites, trusted opt-ins, model-configuration independence, dependencies/conflicts, budgets, integrity, external loading suppression and worker wiring. It does not prove live GPU quality or live executor connectivity.

`services/agent-worker/src/minimal-skill-worker.test.ts` also loads the actual shipped manifest and original skill bodies through the production worker and adapter factory. HTTP transports and the security executor are controlled fixtures. It covers stable Q&A, search plus opened current evidence, scoped security observations and continuation with both `qwen-llamacpp` and `generic-openai`, a replacement model identity, scope rejection, separate active-test permission and cancellation. `packages/skill-engine/src/manifest-drift.test.ts` verifies that a stale artifact is rejected without silently rewriting it and that deliberate regeneration restores consistency. These tests verify integration contracts; they do not replace live acceptance against real model weights and an authorized target.

Run the existing complete suite as well, particularly model conformance, final grounding/response integrity, conversation history, freshness preflight, scoped HTTP and security-runtime negative cases. No existing tests or release gates are removed or weakened.

## Controlled live acceptance

Use a separate test worker and an owned disposable target or a target covered by current recorded owner authorization. Keep the same model version, inference parameters, tool set, task fixtures and initial conversation state when comparing `minimal` and `legacy`. Keep both workers' external-loading settings equal when isolating only local skill routing; compare external packs separately.

For each run record exact repository/model revision, profile, loaded skill names and size, input-token count from the server if available, time to first token, time to final answer, tool calls/retries, finish reason and evidence-backed completion. Use a fresh conversation per fixture.

Required fixtures: a stable question with no unnecessary tools; a live question answered from opened current sources; a tool-result continuation; a scoped positive Lab check; rejection without authorization; rejection outside scope; cancellation; and a second compatible model with the same fixture set. Run the existing `eval:model-conformance`, `eval:agent-runtime` and `eval:security-pentest-intelligence` commands using their existing authenticated test-environment configuration. Never convert an absent executor or an unsupported specialized capability into a claim of a completed pentest.

Changing the model means configuring the served artifact, endpoint and matching protocol/adapter separately, then passing the same conformance gate. The skill profile must not select or hardcode a model. Do not remove authorization or fabricate success to compensate for a model that cannot continue after a tool result.

## Rollback and incremental trials

To compare the previous routing behavior, set `DIV3RSA_SKILL_PROFILE=legacy` and restart the test worker. Its default external-loading behavior matches the previous opt-in-by-installed-index path. Set `DIV3RSA_SKILL_EXTERNAL_ENABLED=0` as well for a local-skills-only comparison.

To trial one specialist, retain `minimal` and set, for example, `DIV3RSA_SKILL_ADDITIONAL=systematic-debugging`. Check measured benefit before expanding the set. A mode-restricted opt-in is only selected in its supported modes. Production promotion is separate from merging the code and requires live acceptance evidence.
