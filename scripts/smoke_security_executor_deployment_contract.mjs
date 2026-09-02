import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const provision = await readFile(new URL("../infra/runtime/provision-security-executor.sh", import.meta.url), "utf8");
const service = await readFile(new URL("../infra/runtime/div3rsa-security-executor.service", import.meta.url), "utf8");
const supervisor = await readFile(new URL("../infra/runtime/security-executor-supervisor.sh", import.meta.url), "utf8");
const e2e = await readFile(new URL("../infra/runtime/e2e-security-executor.sh", import.meta.url), "utf8");
const cutover = await readFile(new URL("../infra/runtime/cutover-security-runtime-gpuhub.sh", import.meta.url), "utf8");
const nucleiInstaller = await readFile(new URL("../infra/runtime/install-nuclei-scoped-runtime.sh", import.meta.url), "utf8");
const nucleiSnapshot = await readFile(new URL("../infra/runtime/provision-nuclei-template-snapshot.sh", import.meta.url), "utf8");
const nucleiProxy = await readFile(new URL("../infra/runtime/security-assets/nuclei-scope-proxy.mjs", import.meta.url), "utf8");
const agentReadiness = await readFile(new URL("./eval_security_agent_gpuhub.ts", import.meta.url), "utf8");
const workerSecurity = await readFile(new URL("../services/agent-worker/src/security-tool-runtime.ts", import.meta.url), "utf8");
const executorRuntime = await readFile(new URL("../services/security-executor/src/runtime.ts", import.meta.url), "utf8");
const executorMain = await readFile(new URL("../services/security-executor/src/main.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/deploy-gpuhub.yml", import.meta.url), "utf8");

function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`security_deploy_contract_missing:${label}`);
}

for (const script of [
  "../infra/runtime/provision-nuclei-template-snapshot.sh",
  "../infra/runtime/install-nuclei-scoped-runtime.sh",
  "../infra/runtime/cutover-security-runtime-gpuhub.sh"
]) {
  execFileSync("bash", ["-n", new URL(script, import.meta.url).pathname], { stdio: "pipe" });
}

requireText(provision, "INSTALL_ROOT=\"${DIV3RSA_SECURITY_INSTALL_ROOT:-/opt/div3rsa/localai}\"", "isolated_install_root");
requireText(provision, "useradd --system", "locked_service_user");
requireText(provision, "GO_VERSION=\"${DIV3RSA_SECURITY_GO_VERSION:-1.24.1}\"", "pinned_go_version");
requireText(provision, "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz", "official_go_archive");
requireText(provision, "sha256sum -c -", "go_checksum_verification");
if (/apt-get install[^\n]*golang-go/.test(provision)) throw new Error("security_deploy_contract_forbids_unpinned_distro_go");
requireText(provision, "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@${NUCLEI_VERSION}", "pinned_nuclei_install");
requireText(provision, "github.com/ffuf/ffuf/v2@${FFUF_VERSION}", "pinned_ffuf_install");
requireText(provision, "util-linux procps", "portable_supervisor_dependencies");
requireText(provision, "DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED", "worker_runtime_enable");
requireText(provision, "DIV3RSA_SECURITY_EXECUTOR_URL", "worker_executor_url");
requireText(provision, "DIV3RSA_SECURITY_EXECUTOR_TOKEN", "worker_executor_token");
requireText(provision, "DIV3RSA_SECURITY_READINESS_TOKEN", "deploy_readiness_token");
requireText(provision, "openssl rand -hex 32", "random_runtime_credentials");
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
requireText(e2e, "security_target_blocked", "ordinary_loopback_negative_gate");

requireText(cutover, "TEST_IP=\"127.0.0.1\"", "isolated_gpu_loopback_fixture");
requireText(cutover, "deploy-only cryptographic readiness proof", "readiness_proof_comment");
requireText(cutover, "DIV3RSA_SECURITY_READINESS_TOKEN=[0-9a-f]{64}", "worker_readiness_env_proof");
requireText(cutover, "18443", "owned_tls_target");
requireText(cutover, "common-wordlist.txt", "deterministic_discovery_wordlist");
requireText(cutover, "nuclei-readiness.yaml", "deterministic_nuclei_template");
requireText(cutover, "install-nuclei-scoped-runtime.sh", "scoped_nuclei_cutover");
requireText(cutover, "preventing templates from expanding egress", "scoped_template_egress_comment");
requireText(cutover, "DIV3RSA_SECURITY_TOOL_RUNTIME_ENABLED=1", "worker_environment_proof");
requireText(cutover, "scripts/eval_security_agent_gpuhub.ts", "full_agent_readiness_eval");
requireText(cutover, "security-runtime-readiness.json", "readiness_evidence_marker");
requireText(cutover, "v.commit!==process.argv[2]", "stale_readiness_rejection");
requireText(cutover, "security_supervisor status", "portable_service_liveness_proof");
requireText(cutover, "GPUHUB_SECURITY_RUNTIME_AGENT_E2E_OK", "full_agent_cutover_success_marker");
if (cutover.includes("ip link add")) throw new Error("security_deploy_contract_forbids_cap_net_admin_dependency");

requireText(nucleiSnapshot, "b98e6097cb84e73e7a480436062d685a8f898824", "pinned_nuclei_template_commit");
requireText(nucleiSnapshot, "sparse-checkout", "sparse_template_checkout");
for (const directory of ["cves", "exposed-panels", "exposures", "misconfiguration", "technologies", "vulnerabilities"]) {
  requireText(nucleiSnapshot, directory, `curated_template_directory_${directory}`);
}
for (const forbidden of ["credential-stuffing", "token-spray", "interactsh-url", "headless", "javascript"]) {
  requireText(nucleiSnapshot, forbidden, `template_filter_${forbidden}`);
}
requireText(nucleiSnapshot, "chown -R root:div3rsa-security", "templates_read_only_to_executor");
requireText(nucleiSnapshot, "source_commit=", "template_snapshot_manifest");

requireText(nucleiInstaller, "nuclei-scope-proxy.mjs", "nuclei_scope_proxy_install");
requireText(nucleiInstaller, "-proxy-internal", "nuclei_proxy_internal");
requireText(nucleiInstaller, "-type http", "nuclei_http_only");
requireText(nucleiInstaller, "-automatic-scan", "nuclei_technology_scoped_scan");
requireText(nucleiInstaller, "-no-interactsh", "nuclei_interactsh_disabled");
requireText(nucleiInstaller, "-disable-update-check", "nuclei_runtime_update_disabled");
requireText(nucleiInstaller, "-disable-redirects", "nuclei_redirects_disabled");
requireText(nucleiInstaller, "-exclude-tags dos,fuzz,intrusive,headless,credential-stuffing,token-spray", "nuclei_aggressive_tags_excluded");
requireText(nucleiInstaller, "scope proxy failed readiness", "nuclei_proxy_fail_closed");
if (nucleiInstaller.includes("--network host") || nucleiInstaller.includes("docker run")) throw new Error("security_deploy_contract_forbids_docker_nuclei_runtime");

requireText(nucleiProxy, "scope_proxy_pinned_ip_required", "proxy_requires_pinned_ip");
requireText(nucleiProxy, "destinationAllowed", "proxy_destination_gate");
requireText(nucleiProxy, "scope.pinnedAddress", "proxy_connects_only_to_pinned_address");
requireText(nucleiProxy, "403 Forbidden", "proxy_denies_out_of_scope_connect");
requireText(nucleiProxy, 'server.listen(0, listenHost', "proxy_loopback_ephemeral_listener");
if (nucleiProxy.includes("lookup(") || nucleiProxy.includes("dns.resolve")) throw new Error("security_deploy_contract_proxy_must_not_reresolve_target");

requireText(workerSecurity, "readinessLoopbackAllowed", "worker_readiness_gate");
requireText(workerSecurity, "timingSafeEqual", "worker_constant_time_proof_check");
requireText(workerSecurity, "security-readiness-scope", "worker_readiness_scope_lock");
requireText(workerSecurity, 'execute.pathname = "/v1/execute"', "worker_canonical_execute_route");
requireText(workerSecurity, 'capabilities.pathname = "/v1/capabilities"', "worker_canonical_capability_route");
requireText(workerSecurity, "security_operation_unavailable:", "worker_live_capability_execution_gate");
requireText(workerSecurity, "runtimeOperations.has(tool.id)", "worker_live_capability_definition_gate");
requireText(executorRuntime, "readinessLoopbackAllowed", "executor_readiness_gate");
requireText(executorRuntime, "security-readiness-scope", "executor_readiness_scope_lock");
requireText(executorRuntime, "a === 127 && !allowReadinessLoopback", "executor_loopback_exception_is_narrow");
requireText(executorRuntime, "async capabilities()", "executor_capability_probe");
requireText(executorRuntime, "commandAvailable", "executor_binary_readiness");
requireText(executorRuntime, "wordlist_unavailable", "executor_wordlist_readiness");
requireText(executorMain, "DIV3RSA_SECURITY_READINESS_TOKEN", "executor_loads_readiness_token");
requireText(executorMain, 'request.url === "/v1/capabilities"', "executor_capability_endpoint");
requireText(executorMain, "capabilities.ready ? 200 : 503", "executor_health_depends_on_capability_readiness");

for (const tool of ["dns_lookup", "http_probe", "tls_probe", "port_scan", "template_scan", "content_discovery"]) {
  requireText(agentReadiness, `tool: "${tool}"`, `agent_readiness_${tool}`);
}
requireText(agentReadiness, "new AgentWorkerProcessor", "real_agent_processor_chain");
requireText(agentReadiness, "new HttpSecurityToolExecutor", "real_executor_http_chain");
requireText(agentReadiness, "readinessProof", "agent_readiness_proof_propagation");
requireText(agentReadiness, "audit_status_not_completed", "audit_completion_gate");
requireText(agentReadiness, "passed === results.length", "all_capabilities_required");

requireText(workflow, "bash -n infra/runtime/security-executor-supervisor.sh", "supervisor_shell_validation");
requireText(workflow, "cutover-security-runtime-gpuhub.sh", "production_workflow_cutover");
requireText(workflow, "security-executor-supervisor.sh status", "production_supervisor_gate");
requireText(workflow, "security_runtime=ready", "production_ready_marker");

console.log("SECURITY_EXECUTOR_DEPLOYMENT_CONTRACT_OK");
