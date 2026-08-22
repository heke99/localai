import { describe, expect, it } from "vitest";
import { buildRepositoryIndex, searchRepository } from "./index";

describe("repository intelligence", () => {
  it("indexes symbols and dependencies while excluding secrets and vendor files", () => {
    const index = buildRepositoryIndex("repo-1", [
      { path: "src/router.ts", content: "import { gateway } from './gateway';\nexport function routeAgent() { return gateway(); }" },
      { path: ".env", content: "TOKEN=secret" },
      { path: "node_modules/x/index.js", content: "export const ignored = true" }
    ]);
    expect(index.files.map((f) => f.path)).toEqual(["src/router.ts"]);
    expect(index.symbols.some((s) => s.name === "routeAgent")).toBe(true);
    expect(index.edges).toContainEqual({ from: "src/router.ts", to: "src/gateway", kind: "imports" });
  });

  it("ranks exact symbol matches above content matches", () => {
    const index = buildRepositoryIndex("repo-1", [
      { path: "src/a.ts", content: "export function routeAgent() {}" },
      { path: "docs/routing.md", content: "The routeAgent function routes requests." }
    ]);
    expect(searchRepository(index, "routeAgent")[0]?.path).toBe("src/a.ts");
  });
});
