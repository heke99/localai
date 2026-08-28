from pathlib import Path
p = Path("scripts/temp_apply_ngram_promotion.py")
t = p.read_text(encoding="utf-8")
old1 = "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT}\"\\n',\n"
new1 = "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT}\"',\n"
old2 = "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT} spec_type=${TARGET_SPEC_TYPE}\"\\n',\n"
new2 = "    'log \"production profile active: parallel=${TARGET_PARALLEL} total_context=${TARGET_TOTAL_CONTEXT} context_per_slot=${TARGET_CONTEXT_PER_SLOT} spec_type=${TARGET_SPEC_TYPE}\"',\n"
if t.count(old1) != 1 or t.count(old2) != 1:
    raise SystemExit("expected reconcile final-line patch literals not found exactly once")
p.write_text(t.replace(old1, new1, 1).replace(old2, new2, 1), encoding="utf-8")
print("fixed final-line no-newline matcher")
