import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const egress = read("infra/runtime/provision-egress-proxy-gpuhub.sh");
const browser = read("infra/runtime/provision-browser-executor-gpuhub.sh");
const upgrade = read("infra/runtime/upgrade-legacy-gpuhub.sh");
const workflow = read(".github/workflows/gpuhub-network-sidecars-evidence.yml");

const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) throw new Error(`missing ${label}`);
};

requireText(egress, /127\.0\.0\.1/,
  "loopback-only egress bind");
requireText(egress, /div3rsa-egress-proxy\.service/,
  "egress systemd unit");
requireText(egress, /NoNewPrivileges=true/,
  "egress no-new-privileges hardening");
requireText(egress, /_div3rsa_health/,
  "egress health gate");
requireText(egress, /169\.254\.169\.254/,
  "metadata negative gate");

requireText(browser, /127\.0\.0\.1/,
  "loopback-only browser bind");
requireText(browser, /div3rsa-browser-executor\.service/,
  "browser systemd unit");
requireText(browser, /@playwright\/test@1\.62\.1/,
  "pinned Playwright runtime");
requireText(browser, /DIV3RSA_BROWSER_EXECUTOR_TOKEN/,
  "browser executor token");
requireText(browser, /DIV3RSA_EGRESS_PROXY_URL/,
  "browser proxy requirement");
requireText(browser, /NoNewPrivileges=true/,
  "browser no-new-privileges hardening");

requireText(upgrade, /provision-egress-proxy-gpuhub\.sh/,
  "GPUHub upgrade egress provisioning");
requireText(upgrade, /provision-browser-executor-gpuhub\.sh/,
  "GPUHub upgrade browser provisioning");
requireText(upgrade, /NODE_USE_ENV_PROXY/,
  "worker Node proxy enablement");
requireText(upgrade, /DIV3RSA_BROWSER_EXECUTOR_URL/,
  "worker browser URL wiring");
requireText(upgrade, /screen -S \"\$WORKER_SCREEN\" -X quit/,
  "worker-only restart before recovery");

requireText(workflow, /workflows: \["Deploy GPUHub"\]/,
  "post-deploy workflow dependency");
requireText(workflow, /127\.0\.0\.1:7318/,
  "GPUHub egress health verification");
requireText(workflow, /127\.0\.0\.1:7320/,
  "GPUHub browser health verification");
requireText(workflow, /169\.254\.169\.254/,
  "GPUHub metadata egress negative verification");
requireText(workflow, /browser_navigate/,
  "GPUHub live browser navigation verification");
requireText(workflow, /browser out-of-scope gate failed/,
  "GPUHub browser scope negative verification");

console.log("GPUHUB_NETWORK_SIDECARS_CONTRACT_OK");
