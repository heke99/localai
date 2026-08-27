import { readFile } from "node:fs/promises";

const provision = await readFile("infra/runtime/provision-search-native.sh", "utf8");
const capability = await readFile("infra/runtime/check-search-capability.sh", "utf8");
const deploy = await readFile(".github/workflows/deploy-gpuhub.yml", "utf8");

const checks = [
  [provision.includes("- name: bing\n    disabled: false"), "verified Bing engine is not explicitly enabled"],
  [provision.includes("- name: yahoo\n    disabled: false"), "verified Yahoo engine is not explicitly enabled"],
  [provision.includes("check-search-capability.sh"), "SearXNG startup does not use the search capability gate"],
  [capability.includes('payload.get("results") or []'), "search capability gate does not require real results"],
  [capability.includes('payload.get("unresponsive_engines") or []'), "search capability gate does not expose upstream engine failures"],
  [(deploy.match(/check-search-capability\.sh/g) ?? []).length >= 2, "deploy and eval preflight do not both use the search capability gate"],
  [!deploy.includes("search?q=div3rsa-deploy-health&format=json"), "deploy still accepts HTTP-only SearXNG health"],
  [!deploy.includes("search?q=div3rsa-eval-health&format=json"), "eval preflight still accepts HTTP-only SearXNG health"],
];

for (const [ok, message] of checks) {
  if (!ok) throw new Error(message);
}

console.log("[search-runtime-contract] verified engines and result-bearing fail-closed health gates present");
