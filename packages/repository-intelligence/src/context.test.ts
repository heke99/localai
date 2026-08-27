import { describe, expect, it } from "vitest";
import { buildRepositoryIndex } from "./index";
import { planContextCompression, selectRepositoryContext } from "./context";

describe("repository context engine", () => {
  const index = buildRepositoryIndex("repo-1", [
    { path: "src/auth.ts", content: "export function getUser() { return 'u'; }" },
    { path: "src/session.ts", content: "import { getUser } from './auth'; export function session() { return getUser(); }" },
    { path: "app/api/session/route.ts", content: "import { session } from '../../../src/session'; export async function GET() { return session(); }" },
    { path: "tests/session.test.ts", content: "import { GET } from '../app/api/session/route'; test('session', () => GET());" },
    { path: "src/unrelated.ts", content: "export const unrelated = 1;" }
  ]);

  it("selects the matching symbol plus callers, dependencies and impacted tests", () => {
    const packet = selectRepositoryContext(index, "change getUser", { maxTokens: 8_000, dependencyDepth: 3 });
    expect(packet.items.map((item) => item.path)).toEqual(expect.arrayContaining(["src/auth.ts", "src/session.ts", "app/api/session/route.ts", "tests/session.test.ts"]));
    expect(packet.items.map((item) => item.path)).not.toContain("src/unrelated.ts");
    expect(packet.repoMap).toContain("getUser");
  });

  it("honors a token budget instead of blindly returning the repository", () => {
    const packet = selectRepositoryContext(index, "session", { maxTokens: 40, dependencyDepth: 2 });
    expect(packet.estimatedTokens).toBeLessThanOrEqual(40);
    expect(packet.items.length).toBeGreaterThan(0);
  });

  it("uses the three requested compression tiers", () => {
    expect(planContextCompression(7_000)).toEqual({ mode: "none", semanticCompressorRequired: false });
    expect(planContextCompression(12_000)).toEqual({ mode: "deterministic-pruning", semanticCompressorRequired: false });
    expect(planContextCompression(24_000)).toEqual({ mode: "semantic", semanticCompressorRequired: true });
  });
});
