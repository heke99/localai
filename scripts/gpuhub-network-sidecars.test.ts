import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

describe("GPUHub network sidecar deployment contract", () => {
  it("keeps the runtime contract internally consistent", () => {
    const output = run(process.execPath, [path.join(root, "scripts/smoke_gpuhub_network_sidecars_contract.mjs")]);
    expect(output).toContain("GPUHUB_NETWORK_SIDECARS_CONTRACT_OK");
  });

  it("keeps native provisioning and recovery scripts shell-parseable", () => {
    expect(() => run("bash", ["-n", "infra/runtime/provision-egress-proxy-gpuhub.sh"])).not.toThrow();
    expect(() => run("bash", ["-n", "infra/runtime/provision-browser-executor-gpuhub.sh"])).not.toThrow();
    expect(() => run("bash", ["-n", "infra/runtime/upgrade-legacy-gpuhub.sh"])).not.toThrow();
    expect(() => run("bash", ["-n", "infra/runtime/recover-legacy-gpuhub.sh"])).not.toThrow();
  });
});
