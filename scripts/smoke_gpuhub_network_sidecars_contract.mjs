import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const egress = read("infra/runtime/provision-egress-proxy-gpuhub.sh");
const browser = read("infra/runtime/provision-browser-executor-gpuhub.sh");
const browserMain = read("services/browser-executor/src/main.ts");
const browserPolicy = read("services/browser-executor/src/runtime-policy.ts");
const upgrade = read("infra/runtime/upgrade-legacy-gpuhub.sh");
const recover = read("infra/runtime/recover-legacy-gpuhub.sh");
const workflow = read(".github/workflows/gpuhub-network-sidecars-evidence.yml");

const requireText = (source, pattern, label) => {
  if (!pattern.test(source)) throw new Error(`missing ${label}`);
};

requireText(egress, /127\.0\.0\.1/, "loopback-only egress bind");
requireText(egress, /localai-egress/, "egress screen supervisor");
requireText(egress, /setpriv[\s\S]*--no-new-privs/, "egress privilege drop");
requireText(egress, /--reuid=/, "egress non-root uid");
requireText(egress, /_div3rsa_health/, "egress health gate");
requireText(egress, /169\.254\.169\.254/, "metadata negative gate");

requireText(browser, /LISTEN_HOST="127\.0\.0\.1"/, "loopback-only browser bind");
requireText(browser, /localai-browser/, "browser screen supervisor");
requireText(browser, /setpriv[\s\S]*--reuid=/, "browser non-root privilege drop");
requireText(browser, /--no-new-privs/, "browser outer no-new-privileges boundary");
requireText(browser, /--bounding-set=-all/, "browser empty capability bounding set");
requireText(browser, /--inh-caps=-all/, "browser empty inheritable capabilities");
requireText(browser, /--ambient-caps=-all/, "browser empty ambient capabilities");
requireText(browser, /NODE_BIN_DIR="\$\(dirname "\$NODE_BIN"\)"/, "browser paired Node bin directory");
requireText(browser, /NPM_BIN="\$\{NODE_BIN_DIR\}\/npm"/, "browser paired npm path");
requireText(browser, /"\$NPM_BIN" --prefix "\$INSTALL_ROOT" install/, "browser pinned-runtime npm execution");
requireText(browser, /@playwright\/test@\$\{PLAYWRIGHT_VERSION\}/, "pinned Playwright install");
requireText(browser, /PLAYWRIGHT_VERSION="1\.62\.1"/, "pinned Playwright version");
requireText(browser, /chromium_sandbox_probe/, "browser native Chromium sandbox probe");
requireText(browser, /try_selective_apparmor_userns/, "browser selective AppArmor user namespace fallback");
requireText(browser, /userns,/, "browser AppArmor user namespace permission");
requireText(browser, /configure_uid_firewall/, "browser UID firewall fallback");
requireText(browser, /iptables[\s\S]*--uid-owner/, "browser IPv4 owner firewall");
requireText(browser, /ip6tables[\s\S]*--uid-owner/, "browser IPv6 owner firewall");
requireText(browser, /-d 127\.0\.0\.1 --dport 7318 -j ACCEPT/, "browser proxy-only firewall allowance");
requireText(browser, /DIV3RSA_BROWSER_ISOLATION_MODE=\$\{ISOLATION_MODE\}/, "browser selected isolation mode wiring");
requireText(browser, /DIV3RSA_BROWSER_EXECUTOR_TOKEN/, "browser executor token");
requireText(browser, /DIV3RSA_EGRESS_PROXY_URL/, "browser proxy requirement");

requireText(browserMain, /resolveBrowserIsolationConfig/, "browser runtime isolation resolver");
requireText(browserMain, /channel:\s*"chromium"/, "browser new Chromium headless channel");
requireText(browserMain, /chromiumSandbox:\s*isolation\.chromiumSandbox/, "browser runtime-selected Chromium sandbox state");
requireText(browserMain, /isolation:\s*isolation\.mode/, "browser health isolation reporting");
requireText(browserPolicy, /"chromium" \| "uid-firewall"/, "browser isolation mode allowlist");
requireText(browserPolicy, /browser_outer_isolation_requires_non_root/, "browser non-root fallback guard");
requireText(browserPolicy, /browser_outer_isolation_requires_loopback_bind/, "browser loopback bind fallback guard");
requireText(browserPolicy, /browser_outer_isolation_requires_loopback_proxy/, "browser loopback proxy fallback guard");

requireText(upgrade, /provision-egress-proxy-gpuhub\.sh/, "GPUHub upgrade egress provisioning");
requireText(upgrade, /provision-browser-executor-gpuhub\.sh/, "GPUHub upgrade browser provisioning");
requireText(upgrade, /NODE_USE_ENV_PROXY/, "worker Node proxy enablement");
requireText(upgrade, /DIV3RSA_BROWSER_EXECUTOR_URL/, "worker browser URL wiring");
requireText(recover, /provision-egress-proxy-gpuhub\.sh/, "GPUHub recovery egress restoration");
requireText(recover, /provision-browser-executor-gpuhub\.sh/, "GPUHub recovery browser restoration");

requireText(workflow, /workflows: \["Deploy GPUHub"\]/, "post-deploy workflow dependency");
requireText(workflow, /\.localai-egress/, "GPUHub egress screen verification");
requireText(workflow, /\.localai-browser/, "GPUHub browser screen verification");
requireText(workflow, /NoNewPrivs/, "GPUHub no-new-privileges verification");
requireText(workflow, /CapEff/, "GPUHub browser empty effective capability verification");
requireText(workflow, /CapBnd/, "GPUHub browser empty bounding capability verification");
requireText(workflow, /browser_isolation=\$\{isolation\}/, "GPUHub reported adaptive isolation evidence");
requireText(workflow, /iptables -C OUTPUT -m owner --uid-owner/, "GPUHub live IPv4 owner firewall verification");
requireText(workflow, /ip6tables -C OUTPUT -m owner --uid-owner/, "GPUHub live IPv6 owner firewall verification");
requireText(workflow, /Seccomp/, "GPUHub Chromium seccomp verification when native sandbox is active");
requireText(workflow, /127\.0\.0\.1:7318/, "GPUHub egress health verification");
requireText(workflow, /127\.0\.0\.1:7320/, "GPUHub browser health verification");
requireText(workflow, /169\.254\.169\.254/, "GPUHub metadata egress negative verification");
requireText(workflow, /browser_navigate/, "GPUHub live browser navigation verification");
requireText(workflow, /browser out-of-scope gate failed/, "GPUHub browser scope negative verification");
requireText(workflow, /uid-firewall browser can reach the model directly/, "GPUHub browser direct-model negative verification");
requireText(workflow, /uid-firewall browser can reach the public internet directly/, "GPUHub browser direct-internet negative verification");

console.log("GPUHUB_NETWORK_SIDECARS_CONTRACT_OK");
