import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);

async function text(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

describe("browser executor deployment contract", () => {
  it("vendors the Playwright user-namespace seccomp allowances", async () => {
    const profile = JSON.parse(await text("infra/docker/playwright-seccomp.json")) as {
      defaultAction?: string;
      syscalls?: Array<{ comment?: string; names?: string[]; action?: string }>;
    };
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const namespaces = profile.syscalls?.find((entry) => entry.comment === "Allow create user namespaces");
    expect(namespaces?.action).toBe("SCMP_ACT_ALLOW");
    expect(new Set(namespaces?.names)).toEqual(new Set(["clone", "setns", "unshare"]));
  });

  it("keeps the browser opt-in, non-root and sandboxed in compose", async () => {
    const compose = await text("infra/docker/agent-worker.external.compose.yaml");
    expect(compose).toContain('profiles: ["browser"]');
    expect(compose).toContain("seccomp=./playwright-seccomp.json");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("cap_drop:\n      - ALL");
    expect(compose).not.toContain("ipc: host");
    expect(compose).toContain('DIV3RSA_BROWSER_EXECUTOR_URL: "${DIV3RSA_BROWSER_EXECUTOR_URL:-}"');
    expect(compose).toContain('DIV3RSA_BROWSER_EXECUTOR_TOKEN: "${DIV3RSA_BROWSER_EXECUTOR_TOKEN:-}"');
  });

  it("pins the runtime contract to Node 24+ and Playwright 1.62.1", async () => {
    const dockerfile = await text("infra/docker/browser-executor.Dockerfile");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_IMAGE");
    expect(dockerfile).toContain("major < 24");
    expect(dockerfile).toContain("p.version !== '1.62.1'");
    expect(dockerfile).toContain("USER pwuser");
    expect(dockerfile).not.toContain("--no-sandbox");
  });
});
