from pathlib import Path
p = Path("scripts/temp_apply_ngram_promotion.py")
t = p.read_text(encoding="utf-8")
replacements = [
    (
        "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT}\"\\n',\n",
        "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT}\"',\n",
    ),
    (
        "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT} spec_type=${TARGET_SPEC_TYPE}\"\\n',\n",
        "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT} spec_type=${TARGET_SPEC_TYPE}\"',\n",
    ),
    (
        '    \'console.log("[gpuhub-production-profile] durable p8/262144 profile, retrying verification, p1 rollback and post-promotion 8/8 gate present");\\n\',\n',
        '    \'console.log("[gpuhub-production-profile] durable p8/262144 profile, retrying verification, p1 rollback and post-promotion 8/8 gate present");\',\n',
    ),
    (
        '    \'console.log("[gpuhub-production-profile] durable p8/262144 + ngram-mod profile, retrying verification, conservative p1 rollback and post-promotion 8/8 gate present");\\n\',\n',
        '    \'console.log("[gpuhub-production-profile] durable p8/262144 + ngram-mod profile, retrying verification, conservative p1 rollback and post-promotion 8/8 gate present");\',\n',
    ),
]
for old, new in replacements:
    if t.count(old) != 1:
        raise SystemExit(f"expected patch literal not found exactly once: {old[:100]!r}")
    t = t.replace(old, new, 1)
p.write_text(t, encoding="utf-8")
print("fixed no-newline matchers")
