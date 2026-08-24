import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { enqueueOperation } from "../actions";

type Snapshot = {
  model_aliases?: Array<{ alias: string; version_key: string; status: string; repository: string }>;
  gpu_workers?: Array<{ id: string; provider: string; profile: string; state: string; last_heartbeat_at: string | null; version_key: string | null }>;
  skills?: Array<{ key: string; category: string; status: string; active_version: number | null }>;
  knowledge?: Array<{ id: string; scope_type: string; source_type: string; approval_status: string }>;
  jobs?: Array<{ id: string; queue: string; status: string; last_error_code: string | null; updated_at: string }>;
  runs?: Array<{ id: string; mode: string; status: string; failure_code: string | null; active_skill: string | null; created_at: string }>;
};

type PlatformSnapshot = {
  counts?: { repository_indexes?: number; verification_runs?: number; verification_passed?: number; impact_analyses?: number; tracked_runs?: number };
  repository_indexes?: Array<{
    id: string; run_id: string; phase: string; verification_round: number | null; repository: string; ref: string; revision_sha: string;
    status: string; complete: boolean; counts: Record<string, number>; project_profile: Record<string, unknown>; created_at: string; finished_at: string | null;
  }>;
  impacts?: Array<{ id: string; run_id: string; verification_round: number; risk: string; changed_count: number; affected_count: number; test_count: number; created_at: string }>;
  verifications?: Array<{ id: string; run_id: string; verification_round: number; status: string; blockers: string[]; reviewer: { passed?: boolean; reason?: string }; created_at: string; revision_sha: string | null; ref: string | null }>;
  skills?: Array<{ run_id: string; skill_key: string; activation_order: number; status: string; created_at: string }>;
};

type Readiness = "ready" | "foundation";
const architecture: Array<{ name: string; detail: string; state: Readiness }> = [
  { name: "Task intelligence", detail: "Intent, risk, complexity, domains and required verification are computed and persisted before execution.", state: "ready" },
  { name: "Dynamic skill routing", detail: "Approved skills are selected at runtime and persisted with activation order per run.", state: "ready" },
  { name: "Repository intelligence", detail: "Exact Git revisions are indexed with files, symbols, imports, routes, SQL entities and tests before and after mutations.", state: "ready" },
  { name: "Consequence engine", detail: "Changed files are resolved against the exact post-change graph to find callers, dependencies, routes, database impact and affected tests.", state: "ready" },
  { name: "Sandbox verification", detail: "Pinned Docker verification runs non-root, default-deny network and a read-only source snapshot with ephemeral writable workspace.", state: "ready" },
  { name: "Completion gate", detail: "Completion is denied until mandatory checks pass with fresh evidence tied to the post-change state.", state: "ready" },
  { name: "Remediation loop", detail: "Verification blockers are returned to the agent for strategy changes and bounded retries before final failure.", state: "ready" },
  { name: "Persistent audit trail", detail: "Task analysis, skills, graph metadata, impact and every verification round are stored before a run may complete.", state: "ready" },
  { name: "Portable export / import", detail: "Versioned portability contracts exist; operational export/import endpoints and portability self-tests are still pending.", state: "foundation" }
];

const remainingFoundation = [
  "Add AST/LSP-backed symbol and call-graph adapters for deeper language-aware indexing.",
  "Expose operational export/import endpoints and run portability self-tests/evals after a move.",
  "Reuse compatible persisted repository indexes across runs to reduce re-index cost without weakening exact-revision guarantees."
];

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function shortSha(value?: string | null) { return value ? value.slice(0, 10) : "—"; }
function statusClass(status: string) { return status === "passed" || status === "ready" || status === "completed" || status === "production" ? "status-production" : status === "failed" || status === "blocked" ? "status-failed" : "status-pending"; }

export default async function AgentPlatformPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const [controlResult, platformResult] = await Promise.all([
    supabase.rpc("superadmin_control_snapshot"),
    supabase.rpc("superadmin_agent_platform_snapshot")
  ]);
  if (controlResult.error) throw new Error(controlResult.error.message);
  if (platformResult.error) throw new Error(platformResult.error.message);
  const snapshot = (controlResult.data ?? {}) as Snapshot;
  const platform = (platformResult.data ?? {}) as PlatformSnapshot;
  const activeModel = snapshot.model_aliases?.find((item) => item.alias === "general-prod");
  const readyWorkers = snapshot.gpu_workers?.filter((worker) => worker.state === "ready") ?? [];
  const activeSkills = snapshot.skills?.filter((skill) => skill.status === "production" || skill.status === "verified") ?? [];
  const failedJobs = snapshot.jobs?.filter((job) => job.status === "failed") ?? [];
  const failedRuns = snapshot.runs?.filter((run) => run.status === "failed") ?? [];
  const readyComponents = architecture.filter((component) => component.state === "ready").length;
  const liveState = activeModel && readyWorkers.length ? "ready" : activeModel ? "waiting" : "blocked";
  const verificationTotal = platform.counts?.verification_runs ?? 0;
  const verificationPassed = platform.counts?.verification_passed ?? 0;
  const passRate = verificationTotal ? Math.round((verificationPassed / verificationTotal) * 100) : null;

  return <main className="shell control-shell">
    <nav className="nav control-topbar">
      <div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Agent Platform · Superadmin</span></div>
      <div className="control-top-actions"><Link className="button" href="/superadmin">Control center</Link><Link className="button primary" href="/dashboard">User dashboard</Link></div>
    </nav>

    <div className="control-content" style={{ maxWidth: 1320, margin: "0 auto", width: "100%" }}>
      <header className="control-header" id="overview">
        <div><p className="eyebrow">Portable agent engine</p><h1>Agent Platform</h1><p className="lead">Superadmin can inspect the complete decision chain for each run: task classification, selected skills, exact repository revisions, consequence impact and evidence-backed completion checks.</p></div>
        <div className="control-health"><span className={`health-dot ${liveState === "ready" ? "ready" : "waiting"}`} /><div><strong>{liveState === "ready" ? "Inference runtime online" : activeModel ? "Model routed · compute waiting" : "Model route missing"}</strong><small>{activeModel?.version_key ?? "No general-prod model"} · {readyWorkers.length} ready worker(s)</small></div></div>
      </header>

      <div className="control-metrics">
        <article><span>Core readiness</span><strong>{readyComponents}/{architecture.length}</strong><small>{architecture.length - readyComponents} foundation layer</small></article>
        <article><span>Tracked runs</span><strong>{platform.counts?.tracked_runs ?? 0}</strong><small>persistent intelligence traces</small></article>
        <article><span>Repo indexes</span><strong>{platform.counts?.repository_indexes ?? 0}</strong><small>baseline + post-change</small></article>
        <article><span>Verification</span><strong>{passRate === null ? "—" : `${passRate}%`}</strong><small>{verificationPassed}/{verificationTotal} passed rounds</small></article>
        <article><span>Impact analyses</span><strong>{platform.counts?.impact_analyses ?? 0}</strong><small>consequence snapshots</small></article>
        <article><span>Failures</span><strong>{failedJobs.length + failedRuns.length}</strong><small>recent jobs + runs</small></article>
      </div>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Architecture</p><h2>Portable intelligence layers</h2></div><span className="panel-count">{readyComponents} ready</span></div>
        <div className="provider-grid">{architecture.map((component) => <article key={component.name}><div><strong>{component.name}</strong><span className={`status-badge ${component.state === "ready" ? "status-production" : "status-pending"}`}>{component.state}</span></div><p>{component.detail}</p></article>)}</div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Verification evidence</p><h2>Recent completion decisions</h2></div><span className="panel-count">{platform.verifications?.length ?? 0}</span></div>
        {platform.verifications?.length ? <div className="compact-list">{platform.verifications.slice(0, 15).map((verification) => <div className="compact-row" key={verification.id}>
          <div><Link href={`/superadmin/platform/runs/${verification.run_id}`}><strong>Run {verification.run_id.slice(0, 8)} · round {verification.verification_round + 1}</strong></Link><small>{verification.ref ?? "no repo"} · {shortSha(verification.revision_sha)} · {formatDate(verification.created_at)}</small></div>
          <div className="align-right"><span className={`status-badge ${statusClass(verification.status)}`}>{verification.status}</span><small>{verification.blockers?.length ? `${verification.blockers.length} blocker(s)` : verification.reviewer?.reason ?? "evidence complete"}</small></div>
        </div>)}</div> : <p className="empty-state">No persisted verification rounds yet.</p>}
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Repository intelligence</p><h2>Exact revisions and consequence impact</h2></div><span className="panel-count">{platform.repository_indexes?.length ?? 0}</span></div>
        <div className="control-split">
          <div><h3>Recent indexes</h3>{platform.repository_indexes?.length ? <div className="compact-list">{platform.repository_indexes.slice(0, 10).map((index) => <div className="compact-row" key={index.id}><div><Link href={`/superadmin/platform/runs/${index.run_id}`}><strong>{index.repository}</strong></Link><small>{index.phase} · {index.ref} · {shortSha(index.revision_sha)} · {index.counts?.nodes ?? 0} nodes</small></div><span className={`status-badge ${statusClass(index.status)}`}>{index.complete ? "complete" : index.status}</span></div>)}</div> : <p className="empty-state">No repository index traces yet.</p>}</div>
          <div><h3>Recent impact</h3>{platform.impacts?.length ? <div className="compact-list">{platform.impacts.slice(0, 10).map((impact) => <div className="compact-row" key={impact.id}><div><Link href={`/superadmin/platform/runs/${impact.run_id}`}><strong>Run {impact.run_id.slice(0, 8)} · round {impact.verification_round + 1}</strong></Link><small>{impact.changed_count} changed · {impact.affected_count} affected · {impact.test_count} tests</small></div><span className={`status-badge ${impact.risk === "critical" || impact.risk === "high" ? "status-failed" : impact.risk === "medium" ? "status-pending" : "status-production"}`}>{impact.risk}</span></div>)}</div> : <p className="empty-state">No consequence analyses yet.</p>}</div>
        </div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Live runtime</p><h2>Model, compute & execution</h2></div><span className="panel-count">{snapshot.runs?.length ?? 0}</span></div>
        <div className="control-split">
          <div><h3>Model & GPU</h3><div className="compact-list">
            <div className="compact-row"><div><strong>{activeModel?.version_key ?? "No active model"}</strong><small>{activeModel?.repository ?? "Route general-prod first"}</small></div><span className={`status-badge ${activeModel ? "status-production" : "status-failed"}`}>{activeModel ? activeModel.status : "missing"}</span></div>
            {snapshot.gpu_workers?.slice(0, 8).map((worker) => <div className="compact-row" key={worker.id}><div><strong>{worker.provider} · {worker.profile}</strong><small>{worker.version_key ?? "no model"} · heartbeat {formatDate(worker.last_heartbeat_at)}</small></div><span className={`status-badge status-${worker.state}`}>{worker.state}</span></div>)}
          </div></div>
          <div><h3>Recent runs</h3>{snapshot.runs?.length ? <div className="compact-list">{snapshot.runs.slice(0, 10).map((run) => <div className="compact-row" key={run.id}><div><Link href={`/superadmin/platform/runs/${run.id}`}><strong>{run.mode} · {run.active_skill ?? "routing"}</strong></Link><small>{formatDate(run.created_at)}</small></div><div className="align-right"><span className={`status-badge ${statusClass(run.status)}`}>{run.status}</span><small>{run.failure_code ?? "no failure"}</small></div></div>)}</div> : <p className="empty-state">No agent runs yet.</p>}</div>
        </div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Foundation gaps</p><h2>Still required for full master-prompt completion</h2></div><span className="panel-count">{remainingFoundation.length}</span></div>
        <div className="compact-list">{remainingFoundation.map((item, index) => <div className="compact-row" key={item}><div><strong>{String(index + 1).padStart(2, "0")}</strong><small>{item}</small></div><span className="status-badge status-pending">open</span></div>)}</div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Operations</p><h2>Index, learn, evaluate & reconcile</h2></div><span className="panel-count">{snapshot.jobs?.length ?? 0}</span></div>
        <form action={enqueueOperation} className="control-form operation-form">
          <label><span>Operation</span><select name="queue" defaultValue="repository-index"><option value="repository-index">Repository index</option><option value="knowledge-ingestion">Knowledge ingestion</option><option value="eval">Evaluation</option><option value="gpu-reconcile">GPU reconcile</option><option value="training">Training plan</option><option value="rollback">Rollback</option></select></label>
          <label><span>Pinned resource</span><input name="resource" required maxLength={2048} placeholder="repository@revision, source URI, model version or provider/profile" /></label>
          <button className="button primary" type="submit">Queue operation</button>
        </form>
        {snapshot.jobs?.length ? <div className="compact-list spaced-list">{snapshot.jobs.slice(0, 12).map((job) => <div className="compact-row" key={job.id}><div><strong>{job.queue}</strong><small>{formatDate(job.updated_at)}</small></div><div className="align-right"><span className={`status-badge ${statusClass(job.status)}`}>{job.status}</span><small>{job.last_error_code ?? "healthy"}</small></div></div>)}</div> : <p className="empty-state">No queued platform operations.</p>}
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Portability contract</p><h2>What survives a product, model or GPU move</h2></div></div>
        <div className="provider-grid">
          <article><div><strong>Portable</strong><span className="status-badge status-production">keep</span></div><p>Runtime, skills, agents, consequence rules, verification, general knowledge references, eval profile and provider contracts.</p></article>
          <article><div><strong>Remapped</strong><span className="status-badge">configure</span></div><p>Model endpoint, compute, database, Git, deployment, storage and vector-store adapters.</p></article>
          <article><div><strong>Opt-in only</strong><span className="status-badge status-pending">isolated</span></div><p>Project knowledge, repository indexes and project data. They are selected explicitly during import and never move implicitly.</p></article>
          <article><div><strong>Separate artifact</strong><span className="status-badge">model</span></div><p>Model weights are deployed independently from the agent manifest, so replacing hardware or model does not rewrite intelligence.</p></article>
        </div>
      </section>
    </div>
  </main>;
}
