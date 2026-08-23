import { describe, expect, it } from "vitest";
import { integrationToolByName, integrationToolsForResources } from "./tools";

describe("integration tool catalog", () => {
  it("only exposes tools granted to the selected resources", () => {
    const tools = integrationToolsForResources([{ resourceId: "repo-1", connectionId: "connection-1", provider: "github", resourceType: "repository", externalResourceId: "heke99/localai", displayName: "localai", capabilities: ["github.contents.read", "github.pull_request.create"] }]);
    expect(tools.map((tool) => tool.name)).toEqual(["github_read_file", "github_create_pull_request"]);
    const readFile = tools.find((tool) => tool.name === "github_read_file");
    expect((readFile?.inputSchema.properties as { resourceId?: { enum?: string[] } })?.resourceId?.enum).toEqual(["repo-1"]);
  });

  it("keeps destructive actions distinct from ordinary writes", () => {
    expect(integrationToolByName("github_merge_pull_request")?.risk).toBe("destructive");
    expect(integrationToolByName("github_write_file")?.risk).toBe("write");
  });
});
