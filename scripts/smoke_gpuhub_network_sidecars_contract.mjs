import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const egress = read("infra/runtime/provision-egress-proxy-gpuhub.sh");
const browser = read("infra/runtime/provision-browser-executor-gpuhub.sh");
const browserMain = read("services/browser-executor/src/main.ts");
const browserPolicy = read("services/browser-executor/src/runtime-policy.ts");
const browserRuntime = read("services/agent-worker/src/browser-tool-runtime.ts");
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
requireText(browser, /chromium_sandbox_probe/, "browser native Chromium sandbox probe");
requireText(browser, /try_selective_apparmor_userns/, "browser selective AppArmor user namespace fallback");
requireText(browser, /configure_uid_firewall/, "browser UID firewall fallback");
requireText(browser, /iptables[\s\S]*--uid-owner/, "browser IPv4 owner firewall");
requireText(browser, /ip6tables[\s\S]*--uid-owner/, "browser IPv6 owner firewall");
requireText(browser, /UNAVAILABLE_FILE=.*unavailable\.reason/, "browser explicit unavailable marker");
requireText(browser, /unavailable_host_isolation/, "browser explicit unsupported-host reason");
requireText(browser, /exit 78/, "browser dedicated unsupported-host exit code");
requireText(browser, /rm -f "\$TOKEN_FILE" "\$ENV_FILE"/, "browser stale credential cleanup on unsupported host");

requireText(browserMain, /resolveBrowserIsolationConfig/, "browser runtime isolation resolver");
requireText(browserMain, /channel:\s*"chromium"/, "browser Chromium channel");
requireText(browserMain, /chromiumSandbox:\s*isolation\.chromiumSandbox/, "browser runtime-selected Chromium sandbox state");
requireText(browserPolicy, /"chromium" \| "uid-firewall"/, "browser isolation mode allowlist");
requireText(browserPolicy, /browser_outer_isolation_requires_non_root/, "browser non-root fallback guard");

requireText(browserRuntime, /if \(!this\.endpoint \|\| !this\.token\) return \[\];/, "worker hides browser tools without executor configuration");

requireText(upgrade, /provision-egress-proxy-gpuhub\.sh/, "GPUHub upgrade egress provisioning");
requireText(upgrade, /provision-browser-executor-gpuhub\.sh/, "GPUHub upgrade browser provisioning");
requireText(upgrade, /browser_rc.*78/, "GPUHub upgrade handles only dedicated browser-unavailable code");
requireText(upgrade, /remove_env_value DIV3RSA_BROWSER_EXECUTOR_URL/, "GPUHub removes stale browser URL");
requireText(upgrade, /remove_env_value DIV3RSA_BROWSER_EXECUTOR_TOKEN/, "GPUHub removes stale browser token");
requireText(upgrade, /browser capability disabled: unavailable_host_isolation/, "GPUHub reports disabled browser capability");
requireText(upgrade, /NODE_USE_ENV_PROXY/, "worker Node proxy enablement");
requireText(recover, /provision-egress-proxy-gpuhub\.sh/, "GPUHub recovery egress restoration");
requireText(recover, /provision-browser-executor-gpuhub\.sh/, "GPUHub recovery browser restoration");

requireText(workflow, /workflows: \["Deploy GPUHub"\]/, "post-deploy workflow dependency");
requireText(workflow, /\.localai-egress/, "GPUHub egress screen verification");
requireText(workflow, /unavailable\.reason/, "GPUHub browser unavailable marker verification");
requireText(workflow, /unavailable_host_isolation/, "GPUHub exact browser unavailable reason verification");
requireText(workflow, /browser_isolation=unavailable_host_isolation/, "GPUHub disabled browser evidence output");
requireText(workflow, /DIV3RSA_BROWSER_EXECUTOR_URL=/, "GPUHub worker browser URL absence verification");
requireText(workflow, /DIV3RSA_BROWSER_EXECUTOR_TOKEN=/, "GPUHub worker browser token absence verification");
requireText(workflow, /127\.0\.0\.1:7318/, "GPUHub egress health verification");
requireText(workflow, /169\.254\.169\.254/, "GPUHub metadata egress negative verification");
requireText(workflow, /browser_navigate/, "GPUHub live browser navigation verification when available");
requireText(workflow, /Seccomp/, "GPUHub Chromium seccomp verification when native sandbox is active");

console.log("GPUHUB_NETWORK_SIDECARS_CONTRACT_OK");
