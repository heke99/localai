import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const script = await readFile(new URL("./e2e-security-executor.sh", import.meta.url), "utf8");

describe("production security executor external egress gate", () => {
  it("defaults to the owned LocalAI production endpoint but remains explicitly disableable", () => {
    expect(script).toContain('TARGET="${DIV3RSA_SECURITY_E2E_TARGET-https://system.div3rsa.com}"');
    expect(script).toContain('controlled positive target explicitly disabled');
  });

  it("requires actual successful passive probe results, not only a valid response shape", () => {
    expect(script).toContain('if(v.ok!==true||typeof v.auditId!=="string"');
    expect(script).toContain('execute_probe dns_lookup passive');
    expect(script).toContain('execute_probe http_probe passive');
  });

  it("builds valid default JSON options without brace-expansion ambiguity", () => {
    expect(script).toContain('options="${4:-}"');
    expect(script).toContain("[[ -n \"$options\" ]] || options='{}'");
    expect(script).not.toContain('options="${4:-{}}"');
  });

  it("does not enable an active external scan by default", () => {
    expect(script).toContain('ACTIVE="${DIV3RSA_SECURITY_E2E_ACTIVE:-0}"');
    expect(script).toContain('active live probe skipped; passive external egress is sufficient for the production network gate');
  });
});
