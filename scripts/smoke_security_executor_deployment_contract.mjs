import { readFile } from "node:fs/promises";

const provision = await readFile(new URL("../infra/runtime/provision-security-executor.sh", import.meta.url), "utf8");
const service = await readFile(new URL("../infra/runtime/div3rsa-security-executor.service", import.meta.url), "utf8");
const supervisor = await readFile(new URL("../infra/runtime/security-executor-supervisor.sh", import.meta.url), "utf8");
const e2e = await readFile(new URL("../infra/runtime/e2e-security-executor.sh", import.meta.url), "utf8");
const cutover = await readFile(new URL("../infra/runtime/cutover-security-runtime-gpuhub.sh", import.meta.url), "utf8");
const agentReadiness = await readFile(new URL("./eval_security_agent_gpuhub.ts", import.meta.url), "utf8");
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
requireText(provision, "util-linux procps", "portable_supervisor_dependencies");
requireText(provision, "DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED", "worker_runtime_enable");
requireText(provision, "DIV3RSA_SECURITY_EXECUTOR_URL", "worker_executor_url");
requireText(provision, "DIV3RSA_SECURITY_EXECUTOR_TOKEN", "worker_executor_token");
requireText(provision, "security-executor-supervisor.sh\" restart", "portable_service_restart");
requireText(provision, "/health", "health_gate");

requireText(service, "User=div3rsa-security", "systemd_user");
requireText(service, "NoNewPrivileges=true", "no_new_privileges");
requireText(service, "ProtectSystem=strict", "protect_system");
requireText(service, "PrivateDevices=true", "private_devices");
requireText(service, "CapabilityBoundingSet=", "empty_capability_bounding_set");
requireText(service, "AmbientCapabilities=", "empty_ambient_capabilities");
requireText(service, "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "address_family_restriction");
if (/MemoryDenyWriteExecute=true/.test(service)) throw new Error("security_deploy_contract_node_jit_incompatible_hardening");

requireText(supervisor, "cat /proc/1/comm", "systemd_pid1_detection");
requireText(supervisor, "runuser -u \"$SERVICE_USER\"", "locked_user_fallback");
requireText(supervisor, "setsid bash -c", "detached_fallback_runtime");
requireText(supervisor, "pid_alive", "fallback_pid_validation");
requireText(supervisor, "services/security-executor/src/main\\.ts", "fallback_process_identity");

requireText(e2e, "unauthorized gate expected 401", "auth_negative_gate");
requireText(e2e, "security_target_blocked", "loopback_negative_gate");
requireText(e2e, "DIV3RSA_SECURITY_E2E_TARGET", "controlled_target_gate");
requireText(e2e, "DIV3RSA_SECURITY_E2E_ACTIVE", "active_opt_in");
requireText(e2e, "DIV3RSA_SECURITY_E2E_ACTIVE_PORTS", "bounded_active_ports");
requireText(e2e, "port_scan", "bounded_active_probe");

requireText(cutover, "ip -o -4 addr show scope global", "owned_existing_network_target");
requireText(cutover, "security E2E target must be an owned RFC1918 address", "private_test_address");
requireText(cutover, "security E2E address is not assigned to this GPUHub node", "owned_address_proof");
if (cutover.includes("ip link add")) throw new Error("security_deploy_contract_forbids_cap_net_admin_dependency");
requireText(cutover, "18443", "owned_tls_target");
requireText(cutover, "common-wordlist.txt", "deterministic_discovery_wordlist");
requireText(cutover, "nuclei-readiness.yaml", "deterministic_nuclei_template");
requireText(cutover, "DIV3RSA_SECURITY_E2E_ACTIVE=1", "live_active_gate");
requireText(cutover, "DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED=1", "worker_environment_proof");
requireText(cutover, "scripts/eval_security_agent_gpuhub.ts", "full_agent_readiness_eval");
requireText(cutover, "security-runtime-readiness.json", "readiness_evidence_marker");
requireText(cutover, "v.commit!==process.argv[2]", "stale_readiness_rejection");
requireText(cutover, "security_supervisor status", "portable_service_liveness_proof");
requireText(cutover, "GPUHUB_SECURITY_RUNTIME_AGENT_E2E_OK", "full_agent_cutover_success_marker");

for (const tool of ["dns_lookup", "http_probe", "tls_probe", "port_scan", "template_scan", "content_discovery"]) {
  requireText(agentReadiness, `tool: "${tool}"`, `agent_readiness_${tool}`);
}
requireText(agentReadiness, "new AgentWorkerProcessor", "real_agent_processor_chain");
requireText(agentReadiness, "new HttpSecurityToolExecutor", "real_executor_http_chain");
requireText(agentReadiness, "audit_status_not_completed", "audit_completion_gate");
requireText(agentReadiness, "passed === results.length", "all_capabilities_required");

requireText(workflow, "bash -n infra/runtime/security-executor-supervisor.sh", "supervisor_shell_validation");
requireText(workflow, "cutover-security-runtime-gpuhub.sh", "production_workflow_cutover");
requireText(workflow, "security-executor-supervisor.sh status", "production_supervisor_gate");
requireText(workflow, "security_runtime=ready", "production_ready_marker");

console.log("SECURITY_EXECUTOR_DEPLOYMENT_CONTRACT_OK");
