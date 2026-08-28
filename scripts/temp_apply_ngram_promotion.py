from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# Durable tracked profile: preserve p8/context and add the production-tested
# shared ngram speculative decoder. cache-reuse is deliberately omitted because
# the production benchmark measured no material improvement over cache_prompt.
replace_once(
    "infra/runtime/gpuhub-production-profile.env",
    "DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT=32768\n",
    "DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT=32768\n"
    "# Production benchmark 2026-08-28: ngram-mod preserved the 8/8 agent gate and\n"
    "# materially accelerated repeated reasoning paths without a second draft model.\n"
    "DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE=ngram-mod\n",
)

# Recovery-v2: resolve speculative mode using the same command/profile/override
# precedence as parallel/context, and only emit --spec-type for a tested non-none mode.
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    'REQUESTED_MODEL_PARALLEL="${DIV3RSA_MODEL_PARALLEL:-}"\nREQUESTED_MODEL_TOTAL_CONTEXT="${DIV3RSA_MODEL_CONTEXT_SIZE:-}"\n',
    'REQUESTED_MODEL_PARALLEL="${DIV3RSA_MODEL_PARALLEL:-}"\n'
    'REQUESTED_MODEL_TOTAL_CONTEXT="${DIV3RSA_MODEL_CONTEXT_SIZE:-}"\n'
    'REQUESTED_MODEL_SPEC_TYPE="${DIV3RSA_MODEL_SPEC_TYPE:-}"\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    'PROFILE_CONTEXT_PER_SLOT=32768\nif [[ -f "$PROFILE_FILE" ]]; then\n',
    'PROFILE_CONTEXT_PER_SLOT=32768\nPROFILE_SPEC_TYPE=ngram-mod\nif [[ -f "$PROFILE_FILE" ]]; then\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '  PROFILE_CONTEXT_PER_SLOT="${DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT:-$PROFILE_CONTEXT_PER_SLOT}"\nfi\n\nOVERRIDE_PARALLEL=""\nOVERRIDE_TOTAL_CONTEXT=""\n',
    '  PROFILE_CONTEXT_PER_SLOT="${DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT:-$PROFILE_CONTEXT_PER_SLOT}"\n'
    '  PROFILE_SPEC_TYPE="${DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE:-$PROFILE_SPEC_TYPE}"\n'
    'fi\n\nOVERRIDE_PARALLEL=""\nOVERRIDE_TOTAL_CONTEXT=""\nOVERRIDE_SPEC_TYPE=""\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '  OVERRIDE_TOTAL_CONTEXT="${DIV3RSA_GPUHUB_OVERRIDE_TOTAL_CONTEXT:-}"\nfi\n\nMODEL_PARALLEL="${REQUESTED_MODEL_PARALLEL:-${OVERRIDE_PARALLEL:-$PROFILE_PARALLEL}}"\nMODEL_TOTAL_CONTEXT="${REQUESTED_MODEL_TOTAL_CONTEXT:-${OVERRIDE_TOTAL_CONTEXT:-$PROFILE_TOTAL_CONTEXT}}"\n',
    '  OVERRIDE_TOTAL_CONTEXT="${DIV3RSA_GPUHUB_OVERRIDE_TOTAL_CONTEXT:-}"\n'
    '  OVERRIDE_SPEC_TYPE="${DIV3RSA_GPUHUB_OVERRIDE_SPEC_TYPE:-}"\n'
    'fi\n\nMODEL_PARALLEL="${REQUESTED_MODEL_PARALLEL:-${OVERRIDE_PARALLEL:-$PROFILE_PARALLEL}}"\n'
    'MODEL_TOTAL_CONTEXT="${REQUESTED_MODEL_TOTAL_CONTEXT:-${OVERRIDE_TOTAL_CONTEXT:-$PROFILE_TOTAL_CONTEXT}}"\n'
    'MODEL_SPEC_TYPE="${REQUESTED_MODEL_SPEC_TYPE:-${OVERRIDE_SPEC_TYPE:-$PROFILE_SPEC_TYPE}}"\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '[[ "$MODEL_CONTEXT_PER_SLOT" -ge "$PROFILE_CONTEXT_PER_SLOT" ]] \\\n  || fatal "resolved context per slot ${MODEL_CONTEXT_PER_SLOT} is below required ${PROFILE_CONTEXT_PER_SLOT}"\n\nhealth() {\n',
    '[[ "$MODEL_CONTEXT_PER_SLOT" -ge "$PROFILE_CONTEXT_PER_SLOT" ]] \\\n  || fatal "resolved context per slot ${MODEL_CONTEXT_PER_SLOT} is below required ${PROFILE_CONTEXT_PER_SLOT}"\n'
    'case "$MODEL_SPEC_TYPE" in\n'
    '  none|ngram-mod) ;;\n'
    '  *) fatal "unsupported production speculative decoder: ${MODEL_SPEC_TYPE}" ;;\n'
    'esac\n\nhealth() {\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '  ACTIVE_TOTAL_CONTEXT="$(sed -nE \'s/.*--ctx-size[= ]+([0-9]+).*/\\1/p\' <<<"$cmd")"\n  [[ "$ACTIVE_PARALLEL" =~ ^[0-9]+$ && "$ACTIVE_TOTAL_CONTEXT" =~ ^[0-9]+$ ]] || return 1\n',
    '  ACTIVE_TOTAL_CONTEXT="$(sed -nE \'s/.*--ctx-size[= ]+([0-9]+).*/\\1/p\' <<<"$cmd")"\n'
    '  ACTIVE_SPEC_TYPE="$(sed -nE \'s/.*--spec-type[= ]+([^ ]+).*/\\1/p\' <<<"$cmd")"\n'
    '  [[ -n "$ACTIVE_SPEC_TYPE" ]] || ACTIVE_SPEC_TYPE=none\n'
    '  [[ "$ACTIVE_PARALLEL" =~ ^[0-9]+$ && "$ACTIVE_TOTAL_CONTEXT" =~ ^[0-9]+$ ]] || return 1\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '  log "forced profile reconciliation requested: parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT} context_per_slot=${MODEL_CONTEXT_PER_SLOT}"\nelse\n  log "Qwen is unhealthy; beginning recovery with parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT}"\n',
    '  log "forced profile reconciliation requested: parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT} context_per_slot=${MODEL_CONTEXT_PER_SLOT} spec_type=${MODEL_SPEC_TYPE}"\n'
    'else\n'
    '  log "Qwen is unhealthy; beginning recovery with parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT} spec_type=${MODEL_SPEC_TYPE}"\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '  --ubatch-size "$MODEL_UBATCH_SIZE"\n  --no-webui\n)\n\nfor ((attempt=1; attempt<=MODEL_RECOVERY_ATTEMPTS; attempt+=1)); do\n',
    '  --ubatch-size "$MODEL_UBATCH_SIZE"\n'
    '  --no-webui\n'
    ')\n'
    'if [[ "$MODEL_SPEC_TYPE" != "none" ]]; then\n'
    '  MODEL_CMD+=(--spec-type "$MODEL_SPEC_TYPE")\n'
    'fi\n\nfor ((attempt=1; attempt<=MODEL_RECOVERY_ATTEMPTS; attempt+=1)); do\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '  printf \'\\n=== %s recovery-v2 attempt %d/%d parallel=%s total_context=%s ===\\n\' \\\n    "$(date -u +\'%Y-%m-%dT%H:%M:%SZ\')" "$attempt" "$MODEL_RECOVERY_ATTEMPTS" "$MODEL_PARALLEL" "$MODEL_TOTAL_CONTEXT" >>"$RECOVERY_LOG"\n',
    '  printf \'\\n=== %s recovery-v2 attempt %d/%d parallel=%s total_context=%s spec_type=%s ===\\n\' \\\n'
    '    "$(date -u +\'%Y-%m-%dT%H:%M:%SZ\')" "$attempt" "$MODEL_RECOVERY_ATTEMPTS" "$MODEL_PARALLEL" "$MODEL_TOTAL_CONTEXT" "$MODEL_SPEC_TYPE" >>"$RECOVERY_LOG"\n',
)
replace_once(
    "infra/runtime/recover-legacy-gpuhub-v2.sh",
    '      log "Qwen recovered on attempt ${attempt}; pid=${model_pid} parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT}"\n',
    '      log "Qwen recovered on attempt ${attempt}; pid=${model_pid} parallel=${MODEL_PARALLEL} total_context=${MODEL_TOTAL_CONTEXT} spec_type=${MODEL_SPEC_TYPE}"\n',
)

# Reconciler: speculative mode is a first-class part of the tracked production
# profile. Any mismatch forces a controlled restart; rollback restores the exact
# previous speculative state as well as p/context.
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    'BEFORE_TOTAL_CONTEXT=""\nMUTATED=0\n',
    'BEFORE_TOTAL_CONTEXT=""\nBEFORE_SPEC_TYPE=""\nMUTATED=0\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    'TARGET_CONTEXT_PER_SLOT="${DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT:-}"\nfor name in TARGET_PARALLEL TARGET_TOTAL_CONTEXT TARGET_CONTEXT_PER_SLOT; do\n',
    'TARGET_CONTEXT_PER_SLOT="${DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT:-}"\n'
    'TARGET_SPEC_TYPE="${DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE:-none}"\n'
    'for name in TARGET_PARALLEL TARGET_TOTAL_CONTEXT TARGET_CONTEXT_PER_SLOT; do\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    '[[ "$TARGET_TOTAL_CONTEXT" -eq $((TARGET_PARALLEL * TARGET_CONTEXT_PER_SLOT)) ]] \\\n  || fatal "tracked profile does not preserve context per slot"\n\nensure_env_value() {\n',
    '[[ "$TARGET_TOTAL_CONTEXT" -eq $((TARGET_PARALLEL * TARGET_CONTEXT_PER_SLOT)) ]] \\\n'
    '  || fatal "tracked profile does not preserve context per slot"\n'
    'case "$TARGET_SPEC_TYPE" in\n'
    '  none|ngram-mod) ;;\n'
    '  *) fatal "unsupported tracked speculative decoder: ${TARGET_SPEC_TYPE}" ;;\n'
    'esac\n\nensure_env_value() {\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    '  ACTIVE_TOTAL_CONTEXT="$(sed -nE \'s/.*--ctx-size[= ]+([0-9]+).*/\\1/p\' <<<"$cmd")"\n  if [[ ! "$ACTIVE_PARALLEL" =~ ^[0-9]+$ || ! "$ACTIVE_TOTAL_CONTEXT" =~ ^[0-9]+$ ]]; then\n',
    '  ACTIVE_TOTAL_CONTEXT="$(sed -nE \'s/.*--ctx-size[= ]+([0-9]+).*/\\1/p\' <<<"$cmd")"\n'
    '  ACTIVE_SPEC_TYPE="$(sed -nE \'s/.*--spec-type[= ]+([^ ]+).*/\\1/p\' <<<"$cmd")"\n'
    '  [[ -n "$ACTIVE_SPEC_TYPE" ]] || ACTIVE_SPEC_TYPE=none\n'
    '  if [[ ! "$ACTIVE_PARALLEL" =~ ^[0-9]+$ || ! "$ACTIVE_TOTAL_CONTEXT" =~ ^[0-9]+$ ]]; then\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    '  PROFILE_READ_DETAIL="parallel=${ACTIVE_PARALLEL} total_context=${ACTIVE_TOTAL_CONTEXT}"\n',
    '  PROFILE_READ_DETAIL="parallel=${ACTIVE_PARALLEL} total_context=${ACTIVE_TOTAL_CONTEXT} spec_type=${ACTIVE_SPEC_TYPE}"\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    '  if [[ "$ACTIVE_PARALLEL" != "$TARGET_PARALLEL" || "$ACTIVE_TOTAL_CONTEXT" != "$TARGET_TOTAL_CONTEXT" ]]; then\n    VERIFY_DETAIL="profile_mismatch active=${ACTIVE_PARALLEL}/${ACTIVE_TOTAL_CONTEXT} target=${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}"\n',
    '  if [[ "$ACTIVE_PARALLEL" != "$TARGET_PARALLEL" || "$ACTIVE_TOTAL_CONTEXT" != "$TARGET_TOTAL_CONTEXT" || "$ACTIVE_SPEC_TYPE" != "$TARGET_SPEC_TYPE" ]]; then\n'
    '    VERIFY_DETAIL="profile_mismatch active=${ACTIVE_PARALLEL}/${ACTIVE_TOTAL_CONTEXT}/${ACTIVE_SPEC_TYPE} target=${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}/${TARGET_SPEC_TYPE}"\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    '  VERIFY_DETAIL="ok active=${ACTIVE_PARALLEL}/${ACTIVE_TOTAL_CONTEXT} reported_context=${reported}"\n',
    '  VERIFY_DETAIL="ok active=${ACTIVE_PARALLEL}/${ACTIVE_TOTAL_CONTEXT}/${ACTIVE_SPEC_TYPE} reported_context=${reported}"\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    '  log "profile reconciliation failed; restoring previous runtime parallel=${BEFORE_PARALLEL} total_context=${BEFORE_TOTAL_CONTEXT}"\n',
    '  log "profile reconciliation failed; restoring previous runtime parallel=${BEFORE_PARALLEL} total_context=${BEFORE_TOTAL_CONTEXT} spec_type=${BEFORE_SPEC_TYPE}"\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    '  DIV3RSA_MODEL_PARALLEL="$BEFORE_PARALLEL" \\\n  DIV3RSA_MODEL_CONTEXT_SIZE="$BEFORE_TOTAL_CONTEXT" \\\n    bash "$RECOVERY_SCRIPT"\n',
    '  DIV3RSA_MODEL_PARALLEL="$BEFORE_PARALLEL" \\\n'
    '  DIV3RSA_MODEL_CONTEXT_SIZE="$BEFORE_TOTAL_CONTEXT" \\\n'
    '  DIV3RSA_MODEL_SPEC_TYPE="$BEFORE_SPEC_TYPE" \\\n'
    '    bash "$RECOVERY_SCRIPT"\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    'BEFORE_TOTAL_CONTEXT="$ACTIVE_TOTAL_CONTEXT"\nENV_BACKUP="$(mktemp /tmp/div3rsa-gpuhub-env.XXXXXX)"\n',
    'BEFORE_TOTAL_CONTEXT="$ACTIVE_TOTAL_CONTEXT"\nBEFORE_SPEC_TYPE="$ACTIVE_SPEC_TYPE"\nENV_BACKUP="$(mktemp /tmp/div3rsa-gpuhub-env.XXXXXX)"\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    'if [[ "$BEFORE_PARALLEL" != "$TARGET_PARALLEL" || "$BEFORE_TOTAL_CONTEXT" != "$TARGET_TOTAL_CONTEXT" ]]; then\n  log "reconciling llama.cpp ${BEFORE_PARALLEL}/${BEFORE_TOTAL_CONTEXT} -> ${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}"\n  DIV3RSA_FORCE_MODEL_RESTART=1 \\\n  DIV3RSA_MODEL_PARALLEL="$TARGET_PARALLEL" \\\n  DIV3RSA_MODEL_CONTEXT_SIZE="$TARGET_TOTAL_CONTEXT" \\\n    bash "$RECOVERY_SCRIPT"\nelse\n  log "llama.cpp already matches tracked production profile ${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}"\nfi\n',
    'if [[ "$BEFORE_PARALLEL" != "$TARGET_PARALLEL" || "$BEFORE_TOTAL_CONTEXT" != "$TARGET_TOTAL_CONTEXT" || "$BEFORE_SPEC_TYPE" != "$TARGET_SPEC_TYPE" ]]; then\n'
    '  log "reconciling llama.cpp ${BEFORE_PARALLEL}/${BEFORE_TOTAL_CONTEXT}/${BEFORE_SPEC_TYPE} -> ${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}/${TARGET_SPEC_TYPE}"\n'
    '  DIV3RSA_FORCE_MODEL_RESTART=1 \\\n'
    '  DIV3RSA_MODEL_PARALLEL="$TARGET_PARALLEL" \\\n'
    '  DIV3RSA_MODEL_CONTEXT_SIZE="$TARGET_TOTAL_CONTEXT" \\\n'
    '  DIV3RSA_MODEL_SPEC_TYPE="$TARGET_SPEC_TYPE" \\\n'
    '    bash "$RECOVERY_SCRIPT"\n'
    'else\n'
    '  log "llama.cpp already matches tracked production profile ${TARGET_PARALLEL}/${TARGET_TOTAL_CONTEXT}/${TARGET_SPEC_TYPE}"\n'
    'fi\n',
)
replace_once(
    "infra/runtime/reconcile-gpuhub-production-profile.sh",
    'log "production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT}"\n',
    'log "production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT} spec_type=${TARGET_SPEC_TYPE}"\n',
)

# Emergency p1 rollback explicitly disables speculation to recover the proven
# conservative baseline, while the durable tracked target remains ngram-mod.
replace_once(
    "infra/runtime/rollback-legacy-gpuhub-p1.sh",
    'DIV3RSA_GPUHUB_OVERRIDE_TOTAL_CONTEXT=32768\nOVERRIDE\n',
    'DIV3RSA_GPUHUB_OVERRIDE_TOTAL_CONTEXT=32768\nDIV3RSA_GPUHUB_OVERRIDE_SPEC_TYPE=none\nOVERRIDE\n',
)
replace_once(
    "infra/runtime/rollback-legacy-gpuhub-p1.sh",
    'DIV3RSA_MODEL_CONTEXT_SIZE=32768 \\\n  bash "$RECOVERY_SCRIPT"\n',
    'DIV3RSA_MODEL_CONTEXT_SIZE=32768 \\\nDIV3RSA_MODEL_SPEC_TYPE=none \\\n  bash "$RECOVERY_SCRIPT"\n',
)
replace_once(
    "infra/runtime/rollback-legacy-gpuhub-p1.sh",
    '[[ "$cmd" =~ --ctx-size[=\\ ]+32768 ]] || fatal "rollback did not restore ctx=32768: $cmd"\n',
    '[[ "$cmd" =~ --ctx-size[=\\ ]+32768 ]] || fatal "rollback did not restore ctx=32768: $cmd"\n'
    '[[ "$cmd" != *"--spec-type"* ]] || fatal "rollback did not disable speculative decoding: $cmd"\n',
)

# Post-deploy p8 verifier must assert the speculative decoder just like p/ctx.
replace_once(
    ".github/workflows/p8-promotion-verify.yml",
    '          target_context_per_slot="$DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT"\n          [[ "$target_parallel" == "8" && "$target_total_context" == "262144" && "$target_context_per_slot" == "32768" ]] || {\n',
    '          target_context_per_slot="$DIV3RSA_GPUHUB_PRODUCTION_CONTEXT_PER_SLOT"\n'
    '          target_spec_type="${DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE:-none}"\n'
    '          [[ "$target_parallel" == "8" && "$target_total_context" == "262144" && "$target_context_per_slot" == "32768" && "$target_spec_type" == "ngram-mod" ]] || {\n',
)
replace_once(
    ".github/workflows/p8-promotion-verify.yml",
    '          [[ "$process" =~ --ctx-size[=\\ ]+262144 ]] || { echo "production is not ctx=262144: $process" >&2; exit 1; }\n',
    '          [[ "$process" =~ --ctx-size[=\\ ]+262144 ]] || { echo "production is not ctx=262144: $process" >&2; exit 1; }\n'
    '          [[ "$process" == *"--spec-type ${target_spec_type}"* ]] || { echo "production speculative decoder mismatch: $process" >&2; exit 1; }\n',
)
replace_once(
    ".github/workflows/p8-promotion-verify.yml",
    '          [[ "$process" =~ --parallel[=\\ ]+8 && "$process" =~ --ctx-size[=\\ ]+262144 ]] || exit 1\n',
    '          [[ "$process" =~ --parallel[=\\ ]+8 && "$process" =~ --ctx-size[=\\ ]+262144 ]] || exit 1\n'
    '          [[ "$process" == *"--spec-type ${target_spec_type}"* ]] || exit 1\n',
)
replace_once(
    ".github/workflows/p8-promotion-verify.yml",
    '          echo "Permanent p8 promotion verified: p8/262144 active, 32768 context per slot, agent eval 8/8."\n',
    '          echo "Permanent p8 promotion verified: p8/262144 active, 32768 context per slot, spec_type=${target_spec_type}, agent eval 8/8."\n',
)

# The primary GPUHub deploy itself also fails closed if reconciliation did not
# activate ngram-mod.
replace_once(
    ".github/workflows/deploy-gpuhub.yml",
    '          pgrep -af \'llama-server.*Qwen3\\.8-27B-OBLITERATED-Q8_0\\.gguf\'\n          echo "GPUHub deploy healthy: requested=${expected_sha} current=${current_sha}"\n',
    '          process="$(pgrep -af \'llama-server.*Qwen3\\.8-27B-OBLITERATED-Q8_0\\.gguf\')"\n'
    '          echo "$process"\n'
    '          [[ "$process" == *"--spec-type ngram-mod"* ]] || { echo "GPUHub deploy missing tracked ngram-mod runtime" >&2; exit 1; }\n'
    '          echo "GPUHub deploy healthy: requested=${expected_sha} current=${current_sha} spec_type=ngram-mod"\n',
)

# Extend source-controlled contract smoke test.
replace_once(
    "scripts/smoke_gpuhub_production_profile_contract.mjs",
    'const readNumber = (name) => {\n',
    'const readString = (name) => {\n'
    '  const match = profile.match(new RegExp(`^${name}=([^\\n]+)$`, "m"));\n'
    '  if (!match) throw new Error(`missing production profile value: ${name}`);\n'
    '  return match[1].trim();\n'
    '};\n\n'
    'const readNumber = (name) => {\n',
)
replace_once(
    "scripts/smoke_gpuhub_production_profile_contract.mjs",
    'if (parallel * perSlot !== totalContext) throw new Error("GPUHub production profile loses per-slot context");\n\nconst checks = [\n',
    'if (parallel * perSlot !== totalContext) throw new Error("GPUHub production profile loses per-slot context");\n'
    'const specType = readString("DIV3RSA_GPUHUB_PRODUCTION_SPEC_TYPE");\n'
    'if (specType !== "ngram-mod") throw new Error(`GPUHub production spec type must be ngram-mod, got ${specType}`);\n\n'
    'const checks = [\n',
)
replace_once(
    "scripts/smoke_gpuhub_production_profile_contract.mjs",
    '  [recovery.includes("REQUESTED_MODEL_TOTAL_CONTEXT"), "recovery command-scoped total-context override missing"],\n',
    '  [recovery.includes("REQUESTED_MODEL_TOTAL_CONTEXT"), "recovery command-scoped total-context override missing"],\n'
    '  [recovery.includes("REQUESTED_MODEL_SPEC_TYPE") && recovery.includes("--spec-type"), "recovery speculative decoder contract missing"],\n',
)
replace_once(
    "scripts/smoke_gpuhub_production_profile_contract.mjs",
    '  [reconcile.includes("TARGET_PARALLEL") && reconcile.includes("TARGET_TOTAL_CONTEXT"), "profile reconciler target validation missing"],\n',
    '  [reconcile.includes("TARGET_PARALLEL") && reconcile.includes("TARGET_TOTAL_CONTEXT") && reconcile.includes("TARGET_SPEC_TYPE"), "profile reconciler target validation missing"],\n'
    '  [reconcile.includes("BEFORE_SPEC_TYPE") && reconcile.includes("DIV3RSA_MODEL_SPEC_TYPE=\"$BEFORE_SPEC_TYPE\""), "profile reconciler speculative rollback missing"],\n',
)
replace_once(
    "scripts/smoke_gpuhub_production_profile_contract.mjs",
    '  [rollback.includes("DIV3RSA_GPUHUB_OVERRIDE_PARALLEL=1"), "explicit p1 emergency rollback missing"],\n',
    '  [rollback.includes("DIV3RSA_GPUHUB_OVERRIDE_PARALLEL=1"), "explicit p1 emergency rollback missing"],\n'
    '  [rollback.includes("DIV3RSA_GPUHUB_OVERRIDE_SPEC_TYPE=none") && rollback.includes("DIV3RSA_MODEL_SPEC_TYPE=none"), "p1 rollback does not disable speculative decoding"],\n',
)
replace_once(
    "scripts/smoke_gpuhub_production_profile_contract.mjs",
    '  [workflow.includes(\'result.get("passed") != 8\') && workflow.includes(\'result.get("liveOracleFailures") != []\') && workflow.includes(\'result.get("modelParallel") != expected_parallel\'), "post-promotion 8/8 agent gate missing"],\n',
    '  [workflow.includes(\'result.get("passed") != 8\') && workflow.includes(\'result.get("liveOracleFailures") != []\') && workflow.includes(\'result.get("modelParallel") != expected_parallel\'), "post-promotion 8/8 agent gate missing"],\n'
    '  [workflow.includes("target_spec_type") && workflow.includes("--spec-type ${target_spec_type}"), "post-promotion speculative runtime verification missing"],\n',
)
replace_once(
    "scripts/smoke_gpuhub_production_profile_contract.mjs",
    'console.log("[gpuhub-production-profile] durable p8/262144 profile, retrying verification, p1 rollback and post-promotion 8/8 gate present");\n',
    'console.log("[gpuhub-production-profile] durable p8/262144 + ngram-mod profile, retrying verification, conservative p1 rollback and post-promotion 8/8 gate present");\n',
)

# Make this major runtime promotion explicitly request the existing post-deploy
# p8 8/8 evaluation workflow.
Path("ops/gpuhub-p8-promotion.request").write_text(
    "requested_at=2026-08-28T21:53:00+02:00\n"
    "target_parallel=8\n"
    "total_context=262144\n"
    "context_per_slot=32768\n"
    "spec_type=ngram-mod\n"
    "post_promotion_eval_cases=8\n"
    "post_promotion_min_pass_rate=1\n"
    "rollback_parallel=1\n"
    "rollback_total_context=32768\n"
    "rollback_spec_type=none\n"
    "reason=promote-production-tested-ngram-mod-speculative-decoding\n",
    encoding="utf-8",
)

print("permanent ngram-mod runtime promotion patch applied")
