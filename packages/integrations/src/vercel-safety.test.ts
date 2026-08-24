import { describe, expect, it } from "vitest";
import { gatewayToolByName, isForbiddenIntegrationToolName } from "../../../apps/web/lib/integrations/tool-catalog";

describe("Vercel integration tool safety", () => {
  it("rejects log drain tool names even if a future catalog entry is introduced", () => {
    expect(isForbiddenIntegrationToolName("vercel_create_log_drain")).toBe(true);
    expect(isForbiddenIntegrationToolName("vercel.drains.create")).toBe(true);
    expect(isForbiddenIntegrationToolName("vercel-log-drain-delete")).toBe(true);
    expect(gatewayToolByName("vercel_create_log_drain")).toBeNull();
  });

  it("keeps the currently supported Vercel operations available", () => {
    expect(isForbiddenIntegrationToolName("vercel_read_logs")).toBe(false);
    expect(gatewayToolByName("vercel_read_logs")?.capability).toBe("vercel.logs.read");
    expect(gatewayToolByName("vercel_create_deployment")?.capability).toBe("vercel.deployments.create");
  });
});
