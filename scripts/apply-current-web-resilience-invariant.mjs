import { readFileSync, writeFileSync } from "node:fs";

const path = "services/agent-worker/src/processor.ts";
const source = readFileSync(path, "utf8");
const before = `            if (!openedNewSource || !toolTrace.slice(evidenceStart).some((item) => item.name === "web_fetch")) {
              throw new Error("grounded_evidence_research_retry_no_opened_source");
            }`;
const after = `            if (!openedNewSource) {
              throw new Error("grounded_evidence_research_retry_no_opened_source");
            }`;
const first = source.indexOf(before);
if (first < 0) throw new Error("patch_anchor_missing:opened_source_invariant");
if (source.indexOf(before, first + before.length) >= 0) throw new Error("patch_anchor_not_unique:opened_source_invariant");
writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
console.log("Simplified opened-source invariant to the successful-fetch state flag.");
