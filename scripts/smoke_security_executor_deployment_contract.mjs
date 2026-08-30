import { readFile } from "node:fs/promises";

const provision = await readFile(new URL("../infra/runtime/provision-security-executor.sh", import.meta.url), "utf8");
const service = await readFile(new URL("../infra/runtime/div3rsa-security-executor.service", import.meta.url), "utf8");
const e2e = await readFile(new URL("../infra/runtime/e2e-security-executor.sh", import.meta.url), "utf8");
const cutover = await readFile(new URL("../infra/runtime/cutover-security-runtime-gpuhub.sh", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/deploy-gpuhub.yml", import.meta.url), "utf8");

function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`security_deploy_contract_missing:${label}`);
}

requireText(provision, "INSTALL_ROOT=\"${DIV3RSA_SECURITY_INSTALL_ROOT:-/opt/div3rsa/localai}\"", "isolated_install_root");
requireText(provision, "useradd --system", "locked_service_user");
requireText(provision, "GO_VERSION=\"${DIV3RSA_SECURITY_GO_VERSION:-1.24.1}\"", "pinned_go_version");
requireText(provision, "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz", "official_go_archive");
requireText(provision, "sha256sum -c -", "go_checksum_verification");
if (/apt-get install[^\n]*golang-go/.test(provision)) throw new Error("security_deploy_contract_forbids_unpinned_distro_go");
requireText(provision, "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@${NUCLEI_VERSION}", "pinned_nuclei_install");
requireText(provision, "github.com/ffuf/ffuf/v2@${FFUF_VERSION}", "pinned_ffuf_install");
requireText(provision, "iproute2", "controlled_e2e_network_dependency");
requireText(provision, "DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED", "worker_runtime_enable");
requireText(provision, "DIV3RSA_SECURITY_EXECUTOR_URL", "worker_executor_url");
requireText(provision, "DIV3RSA_SECURITY_EXECUTOR_TOKEN", "worker_executor_token");
requireText(provision, "systemctl restart", "service_restart");
requireText(provision, "/health", "health_gate");

requireText(service, "User=div3rsa-security", "systemd_user");
requireText(service, "NoNewPrivileges=true", "no_new_privileges");
requireText(service, "ProtectSystem=strict", "protect_system");
requireText(service, "PrivateDevices=true", "private_devices");
requireText(service, "CapabilityBoundingSet=", "empty_capability_bounding_set");
requireText(service, "AmbientCapabilities=", "empty_ambient_capabilities");
requireText(service, "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "address_family_restriction");
if (/MemoryDenyWriteExecute=true/.test(service)) throw new Error("security_deploy_contract_node_jit_incompatible_hardening");

requireText(e2e, "unauthorized gate expected 401", "auth_negative_gate");
requireText(e2e, "security_target_blocked", "loopback_negative_gate");
requireText(e2e, "DIV3RSA_SECURITY_E2E_TARGET", "controlled_target_gate");
requireText(e2e, "DIV3RSA_SECURITY_E2E_ACTIVE", "active_opt_in");
requireText(e2e, "DIV3RSA_SECURITY_E2E_ACTIVE_PORTS", "bounded_active_ports");
requireText(e2e, "port_scan", "bounded_active_probe");

requireText(cutover, "type dummy", "ephemeral_owned_network_target");
requireText(cutover, "10.254.254.1", "private_test_address");
requireText(cutover, "DIV3RSA_SECURITY_E2E_ACTIVE=1", "live_active_gate");
requireText(cutover, "DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED=1", "worker_environment_proof");
requireText(cutover, "systemctl is-active --quiet", "service_liveness_proof");
requireText(cutover, "GPUHUB_SECURITY_RUNTIME_E2E_OK", "cutover_success_marker");

requireText(workflow, "cutover-security-runtime-gpuhub.sh", "production_workflow_cutover");
requireText(workflow, "http://127.0.0.1:7319/health", "production_executor_health_gate");
requireText(workflow, "security_runtime=live", "production_live_marker");

console.log("SECURITY_EXECUTOR_DEPLOYMENT_CONTRACT_OK");
