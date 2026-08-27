import { describe, expect, it } from "vitest";
import { analyzeConsequences, buildFileImpactGraph } from "./consequence-engine";
import { analyzeTask } from "./task-analyzer";
import { assertCompletionAllowed, createVerificationPlan, executeVerificationPlan, type VerificationExecutor } from "./verification-engine";

describe("portable agent platform intelligence", () => {
  it("classifies broad UI database changes as high-risk multi-domain work", () => {
    const task = analyzeTask("code", "Fix the superadmin UI and database migration, run Playwright and deploy to production", {
      frameworks: ["nextjs", "react"], languages: ["typescript"], database: ["postgres"], hosting: ["vercel"]
    });
    expect(task.categories).toEqual(expect.arrayContaining(["bugfix", "database", "frontend", "design", "testing", "deployment"]));
    expect(task.risk).toBe("critical");
    expect(task.requiresBrowser).toBe(true);
    expect(task.reasoningLevel).toBe("deep");
    expect(task.verificationRequirements).toEqual(expect.arrayContaining(["consequence-analysis", "database-invariants", "browser-e2e", "deployment-health"]));
  });

  it("routes changeable real-world rules through current-information research", () => {
    const task = analyzeTask("chat", "Hur får jag visum till Japan och vilka regler gäller nu?");
    expect(task.requiresCurrentInformation).toBe(true);
    expect(task.requiresLiveData).toBe(false);
    expect(task.informationFreshness).toBe("current");
    expect(task.researchDepth).toBe("standard");
    expect(task.reasoningLevel).toBe("standard");
  });

  it("routes realtime facts through the live fast path", () => {
    const task = analyzeTask("chat", "Vilken tid är det i Stockholm just nu?");
    expect(task.requiresCurrentInformation).toBe(true);
    expect(task.requiresLiveData).toBe(true);
    expect(task.informationFreshness).toBe("live");
    expect(task.researchDepth).toBe("fast");
    expect(task.reasoningLevel).toBe("fast");
  });

  it("keeps stable low-risk knowledge off web and repository paths", () => {
    const task = analyzeTask("chat", "Förklara Pythagoras sats enkelt.");
    expect(task.requiresCurrentInformation).toBe(false);
    expect(task.requiresLiveData).toBe(false);
    expect(task.requiresRepository).toBe(false);
    expect(task.informationFreshness).toBe("stable");
    expect(task.researchDepth).toBe("none");
    expect(task.reasoningLevel).toBe("fast");
    expect(task.verificationRequirements).not.toEqual(expect.arrayContaining(["consequence-analysis", "targeted-tests"]));
  });

  it("walks callers and dependencies transitively and selects impacted tests", () => {
    const graph = buildFileImpactGraph({
      files: ["src/auth.ts", "src/session.ts", "app/api/login/route.ts", "tests/login.test.ts"],
      imports: [
        { from: "src/session.ts", to: "src/auth.ts" },
        { from: "app/api/login/route.ts", to: "src/session.ts" },
        { from: "tests/login.test.ts", to: "app/api/login/route.ts" }
      ],
      tests: [{ path: "tests/login.test.ts", targets: ["app/api/login/route.ts"] }]
    });
    const impact = analyzeConsequences(graph, { files: ["src/auth.ts"] });
    expect(impact.direct.map((node) => node.path)).toContain("src/session.ts");
    expect(impact.transitive.map((node) => node.path)).toEqual(expect.arrayContaining(["app/api/login/route.ts", "tests/login.test.ts"]));
    expect(impact.testNodeIds).toContain("file:tests/login.test.ts");
  });

  it("adds semantic route, symbol and database nodes to repository impact", () => {
    const graph = buildFileImpactGraph({
      files: ["src/auth.ts", "app/api/login/route.ts", "supabase/migrations/auth.sql", "tests/login.test.ts"],
      imports: [{ from: "app/api/login/route.ts", to: "src/auth.ts" }],
      symbols: [{ path: "src/auth.ts", name: "verifyUser", kind: "function" }],
      routes: [{ file: "app/api/login/route.ts", path: "/api/login", kind: "api", methods: ["POST"] }],
      databaseEntities: [
        { file: "supabase/migrations/auth.sql", name: "sessions", kind: "table" },
        { file: "supabase/migrations/auth.sql", name: "sessions_select", kind: "policy" },
        { file: "supabase/migrations/auth.sql", name: "login_rpc", kind: "rpc" }
      ],
      tests: [{ path: "tests/login.test.ts", targets: ["app/api/login/route.ts"] }]
    });
    const impact = analyzeConsequences(graph, { files: ["app/api/login/route.ts"] });
    expect(impact.affected.map((node) => node.kind)).toEqual(expect.arrayContaining(["api", "test", "file"]));
    expect(graph.nodes.some((node) => node.kind === "policy" && node.label === "sessions_select")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "rpc" && node.label === "login_rpc")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "symbol" && node.label === "verifyUser")).toBe(true);
  });

  it("requires complete repository intelligence for repository mutations", () => {
    const task = analyzeTask("code", "Fix login", { languages: ["typescript"] });
    const graph = buildFileImpactGraph({ files: ["src/login.ts"], imports: [] });
    const impact = analyzeConsequences(graph, { files: ["src/login.ts"] });
    const plan = createVerificationPlan(task, impact);
    expect(plan.checks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "repository-intelligence", required: true })]));
  });

  it("denies completion when mandatory verification evidence is blocked", async () => {
    const task = analyzeTask("code", "Fix login and deploy", { languages: ["typescript"], hosting: ["vercel"] });
    const graph = buildFileImpactGraph({ files: ["src/login.ts"], imports: [] });
    const impact = analyzeConsequences(graph, { files: ["src/login.ts"] });
    const plan = createVerificationPlan(task, impact);
    const executor: VerificationExecutor = {
      async run(check) {
        if (check.kind === "response-integrity" || check.kind === "consequence-analysis") return { kind: check.kind, status: "passed", summary: "evidence" };
        return { kind: check.kind, status: check.required ? "blocked" : "skipped", summary: "missing" };
      }
    };
    const report = await executeVerificationPlan(plan, executor, { task, impact, output: "fixed" });
    expect(report.passed).toBe(false);
    expect(report.unresolvedBlockers.some((item) => item.startsWith("repository-intelligence:"))).toBe(true);
    expect(report.unresolvedBlockers.some((item) => item.startsWith("targeted-tests:"))).toBe(true);
    expect(() => assertCompletionAllowed(report)).toThrow(/verification_gate_failed/);
  });

  it("allows read-only completion with response integrity and completion proof", async () => {
    const task = analyzeTask("research", "Research portable model gateways");
    const plan = createVerificationPlan(task);
    const report = await executeVerificationPlan(plan, {
      async run(check) { return { kind: check.kind, status: "passed", summary: "ok" }; }
    }, { task, output: "result" });
    expect(plan.checks.map((check) => check.kind)).toEqual(["response-integrity", "completion-proof"]);
    expect(report.passed).toBe(true);
  });
});
