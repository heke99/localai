import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const egress = read("infra/runtime/provision-egress-proxy-gpuhub.sh");
const browser = read("infra/runtime/provision-browser-executor-gpuhub.sh");
const browserMain = read("services/browser-executor/src/main.ts");
const upgrade = read("infra/runtime/upgrade-legacy-gpuhub.sh");
const recover = read("infra/runtime/recover-legacy-gpuhub.sh");
const workflow = read(".github/workflows/gpuhub-network-sidecars-evidence.yml");

const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) throw new Error(`missing ${label}`);
};

requireText(egress, /127\.0\.0\.1/,
  "loopback-only egress bind");
requireText(egress, /localai-egress/,
  "egress screen supervisor");
requireText(egress, /setpriv[\s\S]*--no-new-privs/,
  "egress privilege drop");
requireText(egress, /--reuid=/,
  "egress non-root uid");
requireText(egress, /SIDECAR_NODE_BIN="\$\{INSTALL_ROOT\}\/node"/,
  "egress accessible Node path");
requireText(egress, /install -o root -g root -m 0755 "\$NODE_BIN" "\$SIDECAR_NODE_BIN"/,
  "egress verified Node copy");
requireText(egress, /exec \$\{SIDECAR_NODE_BIN\}/,
  "egress sidecar Node execution");
requireText(egress, /_div3rsa_health/,
  "egress health gate");
requireText(egress, /169\.254\.169\.254/,
  "metadata negative gate");

requireText(browser, /127\.0\.0\.1/,
  "loopback-only browser bind");
requireText(browser, /localai-browser/,
  "browser screen supervisor");
requireText(browser, /setpriv[\s\S]*--reuid=/,
  "browser non-root privilege drop");
if (/setpriv[^\n]*--no-new-privs/.test(browser)) throw new Error("browser must permit Chromium SUID sandbox helper");
requireText(browser, /SIDECAR_NODE_BIN="\$\{INSTALL_ROOT\}\/node"/,
  "browser accessible Node path");
requireText(browser, /install -o root -g "\$SERVICE_USER" -m 0755 "\$NODE_BIN" "\$SIDECAR_NODE_BIN"/,
  "browser verified Node copy");
requireText(browser, /exec \$\{SIDECAR_NODE_BIN\}/,
  "browser sidecar Node execution");
requireText(browser, /NODE_BIN_DIR="\$\(dirname "\$NODE_BIN"\)"/,
  "browser paired Node bin directory");
requireText(browser, /NPM_BIN="\$\{NODE_BIN_DIR\}\/npm"/,
  "browser paired npm path");
requireText(browser, /"\$NPM_BIN" --prefix "\$INSTALL_ROOT" install/,
  "browser pinned-runtime npm execution");
requireText(browser, /export PATH="\$\{NODE_BIN_DIR\}:\$PATH"/,
  "browser Playwright CLI Node path");
requireText(browser, /@playwright\/test@\$\{PLAYWRIGHT_VERSION\}/,
  "pinned Playwright install");
requireText(browser, /PLAYWRIGHT_VERSION="1\.62\.1"/,
  "pinned Playwright version");
requireText(browser, /CHROME_SANDBOX_BIN="\$\{INSTALL_ROOT\}\/chrome-devel-sandbox"/,
  "browser SUID sandbox destination");
requireText(browser, /chrome-linux64\/chrome_sandbox/,
  "browser bundled Chromium sandbox source");
requireText(browser, /install -o root -g root -m 4755/,
  "browser root-owned SUID sandbox install");
requireText(browser, /CHROME_DEVEL_SANDBOX=\$\{CHROME_SANDBOX_BIN\}/,
  "browser Chromium sandbox environment");
requireText(browser, /DIV3RSA_BROWSER_EXECUTOR_TOKEN/,
  "browser executor token");
requireText(browser, /DIV3RSA_EGRESS_PROXY_URL/,
  "browser proxy requirement");

requireText(browserMain, /channel:\s*"chromium"/,
  "browser new Chromium headless channel");
requireText(browserMain, /chromiumSandbox:\s*true/,
  "browser Chromium sandbox enabled");

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

requireText(recover, /provision-egress-proxy-gpuhub\.sh/,
  "GPUHub recovery egress restoration");
requireText(recover, /provision-browser-executor-gpuhub\.sh/,
  "GPUHub recovery browser restoration");

requireText(workflow, /workflows: \["Deploy GPUHub"\]/,
  "post-deploy workflow dependency");
requireText(workflow, /\.localai-egress/,
  "GPUHub egress screen verification");
requireText(workflow, /\.localai-browser/,
  "GPUHub browser screen verification");
requireText(workflow, /NoNewPrivs/,
  "GPUHub egress no-new-privileges verification");
requireText(workflow, /chrome-devel-sandbox/,
  "GPUHub Chromium SUID sandbox verification");
requireText(workflow, /Seccomp/,
  "GPUHub Chromium seccomp verification");
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
