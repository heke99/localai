import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const egress = read("infra/runtime/provision-egress-proxy-gpuhub.sh");
const browser = read("infra/runtime/provision-browser-executor-gpuhub.sh");
const upgrade = read("infra/runtime/upgrade-legacy-gpuhub-base.sh");
const workflow = read(".github/workflows/deploy-gpuhub.yml");

const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) throw new Error(`missing ${label}`);
};

requireText(egress, /127\.0\.0\.1/,
  "loopback-only egress bind");
requireText(egress, /div3rsa-egress-proxy\.service/,
  "egress systemd unit");
requireText(egress, /no-new-privileges|NoNewPrivileges/i,
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

requireText(upgrade, /provision-egress-proxy-gpuhub\.sh/,
  "GPUHub upgrade egress provisioning");
requireText(upgrade, /provision-browser-executor-gpuhub\.sh/,
  "GPUHub upgrade browser provisioning");
requireText(upgrade, /NODE_USE_ENV_PROXY/,
  "worker Node proxy enablement");
requireText(upgrade, /DIV3RSA_BROWSER_EXECUTOR_URL/,
  "worker browser URL wiring");

requireText(workflow, /127\.0\.0\.1:7318\/_div3rsa_health/,
  "GPUHub egress health verification");
requireText(workflow, /127\.0\.0\.1:7320\/health/,
  "GPUHub browser health verification");
requireText(workflow, /169\.254\.169\.254/,
  "GPUHub metadata egress negative verification");

console.log("GPUHUB_NETWORK_SIDECARS_CONTRACT_OK");
