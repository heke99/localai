import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { enqueueOperation } from "../actions";

type Snapshot = {
  counts?: Record<string, number>;
  model_aliases?: Array<{ alias: string; version_key: string; status: string; repository: string }>;
  model_versions?: Array<{ id: string; version_key: string; status: string; quantization: string | null; capabilities: string[] }>;
  gpu_providers?: Array<{ id: string; key: string; enabled: boolean; workers: number }>;
  gpu_workers?: Array<{ id: string; provider: string; profile: string; state: string; last_heartbeat_at: string | null; version_key: string | null }>;
  skills?: Array<{ key: string; category: string; status: string; active_version: number | null }>;
  knowledge?: Array<{ id: string; scope_type: string; source_type: string; approval_status: string }>;
  eval_runs?: Array<{ id: string; status: string; version_key: string | null; created_at: string }>;
  jobs?: Array<{ id: string; queue: string; status: string; last_error_code: string | null; updated_at: string }>;
  runs?: Array<{ id: string; mode: string; status: string; failure_code: string | null; active_skill: string | null; created_at: string }>;
};

type Readiness = "ready" | "foundation";
const architecture: Array<{ name: string; detail: string; state: Readiness }> = [
  { name: "Task intelligence", detail: "Intent, category, risk, complexity, affected domains and verification requirements are computed before execution.", state: "ready" },
  { name: "Dynamic skill routing", detail: "Mode, prompt signals and skill dependencies select a minimal approved skill set at runtime.", state: "ready" },
  { name: "Repository intelligence", detail: "Project profile, files, symbols, imports, Next routes/API, SQL entities, tests and incremental re-indexing are implemented. AST/LSP adapters remain a deeper indexing layer.", state: "foundation" },
  { name: "Consequence engine", detail: "Portable graph traversal supports callers, dependencies, transitive impact, risk and test selection. Production worker currently starts from observed mutations until the persisted repo graph is wired into each run.", state: "foundation" },
  { name: "Verification gate", detail: "Observed mutations require evidence-backed checks. Required checks that are failed, missing or blocked deny completion.", state: "ready" },
  { name: "Independent reviewer", detail: "Medium/high-risk mutation runs can be reviewed through the separate verifier model route before completion.", state: "ready" },
  { name: "Provider abstraction", detail: "Model, compute, database, Git, deployment, object storage and vector store expose provider-neutral contracts.", state: "ready" },
  { name: "Portable export / import", detail: "Versioned manifest, skill/tool/provider compatibility and project-data isolation are defined. Operational export/import API, self-test runner and migration workflow remain to be wired.", state: "foundation" }
];

const remainingFoundation = [
  "Wire persisted repository graph into worker consequence analysis instead of mutation-only seed graphs.",
  "Add AST/LSP-backed symbol/call indexing adapters and richer route/database/test edges.",
  "Expose operational export/import endpoints and execute portability self-tests/evals.",
  "Add sandbox terminal/tool-runner verification so lint, typecheck, tests and Playwright can run directly rather than relying on CI evidence.",
  "Add verification-driven remediation loops so a failed gate can diagnose, change strategy and retry before the run is finally blocked."
];

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export default async function AgentPlatformPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const { data, error } = await supabase.rpc("superadmin_control_snapshot");
  if (error) throw new Error(error.message);
  const snapshot = (data ?? {}) as Snapshot;
  const activeModel = snapshot.model_aliases?.find((item) => item.alias === "general-prod");
  const readyWorkers = snapshot.gpu_workers?.filter((worker) => worker.state === "ready") ?? [];
  const activeSkills = snapshot.skills?.filter((skill) => skill.status === "production" || skill.status === "verified") ?? [];
  const failedJobs = snapshot.jobs?.filter((job) => job.status === "failed") ?? [];
  const failedRuns = snapshot.runs?.filter((run) => run.status === "failed") ?? [];
  const readyComponents = architecture.filter((component) => component.state === "ready").length;
  const liveState = activeModel && readyWorkers.length ? "ready" : activeModel ? "waiting" : "blocked";

  return <main className="shell control-shell">
    <nav className="nav control-topbar">
      <div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Agent Platform · Superadmin</span></div>
      <div className="control-top-actions"><Link className="button" href="/superadmin">Control center</Link><Link className="button primary" href="/dashboard">User dashboard</Link></div>
    </nav>

    <div className="control-content" style={{ maxWidth: 1320, margin: "0 auto", width: "100%" }}>
      <header className="control-header" id="overview">
        <div><p className="eyebrow">Portable agent engine</p><h1>Agent Platform</h1><p className="lead">Runtime intelligence lives above products and providers. Readiness below is intentionally split between production-ready contracts and foundations that still need deeper runtime wiring.</p></div>
        <div className="control-health"><span className={`health-dot ${liveState === "ready" ? "ready" : "waiting"}`} /><div><strong>{liveState === "ready" ? "Inference runtime online" : activeModel ? "Model routed · compute waiting" : "Model route missing"}</strong><small>{activeModel?.version_key ?? "No general-prod model"} · {readyWorkers.length} ready worker(s)</small></div></div>
      </header>

      <div className="control-metrics">
        <article><span>Core readiness</span><strong>{readyComponents}/{architecture.length}</strong><small>{architecture.length - readyComponents} foundation layer(s)</small></article>
        <article><span>Model route</span><strong>{activeModel ? "OK" : "—"}</strong><small>{activeModel?.version_key ?? "not configured"}</small></article>
        <article><span>Compute</span><strong>{readyWorkers.length}</strong><small>ready GPU workers</small></article>
        <article><span>Skills</span><strong>{activeSkills.length}</strong><small>{snapshot.skills?.length ?? 0} registered</small></article>
        <article><span>Knowledge</span><strong>{snapshot.knowledge?.length ?? 0}</strong><small>scoped sources</small></article>
        <article><span>Failures</span><strong>{failedJobs.length + failedRuns.length}</strong><small>recent jobs + runs</small></article>
      </div>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Architecture</p><h2>Portable intelligence layers</h2></div><span className="panel-count">{readyComponents} ready</span></div>
        <div className="provider-grid">{architecture.map((component) => <article key={component.name}><div><strong>{component.name}</strong><span className={`status-badge ${component.state === "ready" ? "status-production" : "status-pending"}`}>{component.state}</span></div><p>{component.detail}</p></article>)}</div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Foundation gaps</p><h2>Still required for full master-prompt completion</h2></div><span className="panel-count">{remainingFoundation.length}</span></div>
        <div className="compact-list">{remainingFoundation.map((item, index) => <div className="compact-row" key={item}><div><strong>{String(index + 1).padStart(2, "0")}</strong><small>{item}</small></div><span className="status-badge status-pending">open</span></div>)}</div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Live runtime</p><h2>Model, compute & execution</h2></div><span className="panel-count">{snapshot.runs?.length ?? 0}</span></div>
        <div className="control-split">
          <div><h3>Model & GPU</h3><div className="compact-list">
            <div className="compact-row"><div><strong>{activeModel?.version_key ?? "No active model"}</strong><small>{activeModel?.repository ?? "Route general-prod first"}</small></div><span className={`status-badge ${activeModel ? "status-production" : "status-failed"}`}>{activeModel ? activeModel.status : "missing"}</span></div>
            {snapshot.gpu_workers?.slice(0, 8).map((worker) => <div className="compact-row" key={worker.id}><div><strong>{worker.provider} · {worker.profile}</strong><small>{worker.version_key ?? "no model"} · heartbeat {formatDate(worker.last_heartbeat_at)}</small></div><span className={`status-badge status-${worker.state}`}>{worker.state}</span></div>)}
          </div></div>
          <div><h3>Recent runs</h3>{snapshot.runs?.length ? <div className="compact-list">{snapshot.runs.slice(0, 10).map((run) => <div className="compact-row" key={run.id}><div><strong>{run.mode} · {run.active_skill ?? "routing"}</strong><small>{formatDate(run.created_at)}</small></div><div className="align-right"><span className={`status-badge status-${run.status}`}>{run.status}</span><small>{run.failure_code ?? "no failure"}</small></div></div>)}</div> : <p className="empty-state">No agent runs yet.</p>}</div>
        </div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Operations</p><h2>Index, learn, evaluate & reconcile</h2></div><span className="panel-count">{snapshot.jobs?.length ?? 0}</span></div>
        <form action={enqueueOperation} className="control-form operation-form">
          <label><span>Operation</span><select name="queue" defaultValue="repository-index"><option value="repository-index">Repository index</option><option value="knowledge-ingestion">Knowledge ingestion</option><option value="eval">Evaluation</option><option value="gpu-reconcile">GPU reconcile</option><option value="training">Training plan</option><option value="rollback">Rollback</option></select></label>
          <label><span>Pinned resource</span><input name="resource" required maxLength={2048} placeholder="repository@revision, source URI, model version or provider/profile" /></label>
          <button className="button primary" type="submit">Queue operation</button>
        </form>
        {snapshot.jobs?.length ? <div className="compact-list spaced-list">{snapshot.jobs.slice(0, 12).map((job) => <div className="compact-row" key={job.id}><div><strong>{job.queue}</strong><small>{formatDate(job.updated_at)}</small></div><div className="align-right"><span className={`status-badge status-${job.status}`}>{job.status}</span><small>{job.last_error_code ?? "healthy"}</small></div></div>)}</div> : <p className="empty-state">No queued platform operations.</p>}
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Portability contract</p><h2>What survives a product, model or GPU move</h2></div></div>
        <div className="provider-grid">
          <article><div><strong>Portable</strong><span className="status-badge status-production">keep</span></div><p>Runtime, skills, agents, consequence rules, verification, general knowledge references, eval profile and provider contracts.</p></article>
          <article><div><strong>Remapped</strong><span className="status-badge">configure</span></div><p>Model endpoint, compute, database, Git, deployment, storage and vector-store adapters.</p></article>
          <article><div><strong>Opt-in only</strong><span className="status-badge status-pending">isolated</span></div><p>Project knowledge, repository indexes and project data. They are selected explicitly during import and never move implicitly.</p></article>
          <article><div><strong>Separate artifact</strong><span className="status-badge">model</span></div><p>Qwen weights are deployed independently from the agent manifest, so replacing hardware or the model does not rewrite intelligence.</p></article>
        </div>
      </section>
    </div>
  </main>;
}
