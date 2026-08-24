import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";

type RunTrace = {
  run?: { id: string; mode: string; status: string; model_alias: string; failure_code: string | null; created_at: string; started_at: string | null; finished_at: string | null; updated_at: string } | null;
  intelligence?: {
    task_analysis?: { primaryCategory?: string; categories?: string[]; risk?: string; complexity?: string; verificationRequirements?: string[]; requiresBrowser?: boolean; requiresDatabase?: boolean; requiresSecurityReview?: boolean; requiresDeployment?: boolean };
    selected_skills?: string[];
    created_at?: string;
    updated_at?: string;
  } | null;
  indexes?: Array<{ id: string; phase: string; verification_round: number | null; repository: string; ref: string; revision_sha: string; content_revision_hash: string; status: string; complete: boolean; project_profile: Record<string, unknown>; counts: Record<string, number>; created_at: string; finished_at: string | null; node_count: number; edge_count: number }>;
  impacts?: Array<{ id: string; verification_round: number; risk: string; changed_count: number; affected_count: number; test_count: number; verification_hints: string[]; nodes: Array<{ node_key: string; kind: string; path: string | null; distance: number; direction: string; via: string | null }>; created_at: string }>;
  verifications?: Array<{ id: string; verification_round: number; status: string; plan: { checks?: Array<{ kind: string; required: boolean; reason: string }> }; blockers: string[]; reviewer: { passed?: boolean; reason?: string }; results: Array<{ check_kind: string; required: boolean; status: string; summary: string; evidence: string[]; duration_ms: number | null }>; created_at: string }>;
  skills?: Array<{ skill_key: string; activation_order: number; status: string; created_at: string }>;
};

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "medium" }).format(date);
}
function shortSha(value?: string | null) { return value ? value.slice(0, 12) : "—"; }
function statusClass(status: string) { return status === "passed" || status === "ready" || status === "completed" ? "status-production" : status === "failed" || status === "blocked" ? "status-failed" : "status-pending"; }
function riskClass(risk?: string) { return risk === "critical" || risk === "high" ? "status-failed" : risk === "medium" ? "status-pending" : "status-production"; }

export default async function AgentRunTracePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) notFound();
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");
  if (user.app_metadata.system_role !== "superadmin") redirect("/dashboard");
  const { data: stepUp, error: stepUpError } = await supabase.rpc("superadmin_email_step_up_status");
  if (stepUpError || !(stepUp as { verified?: boolean } | null)?.verified) redirect("/verify-email");

  const { data, error } = await supabase.rpc("superadmin_agent_run_trace", { target_run_id: runId });
  if (error) {
    if (/agent_run_not_found/i.test(error.message)) notFound();
    throw new Error(error.message);
  }
  const trace = (data ?? {}) as RunTrace;
  if (!trace.run) notFound();
  const task = trace.intelligence?.task_analysis ?? {};

  return <main className="shell control-shell">
    <nav className="nav control-topbar">
      <div><span className="brand">DIV3RSA CONTROL</span><span className="control-role">Run trace · Superadmin</span></div>
      <div className="control-top-actions"><Link className="button" href="/superadmin/platform">Agent Platform</Link><Link className="button primary" href="/superadmin">Control center</Link></div>
    </nav>

    <div className="control-content" style={{ maxWidth: 1320, margin: "0 auto", width: "100%" }}>
      <header className="control-header">
        <div><p className="eyebrow">Evidence chain</p><h1>Run {trace.run.id.slice(0, 8)}</h1><p className="lead">This view exposes decision metadata and verification evidence only. Repository source, credentials and raw tool outputs are intentionally not persisted here.</p></div>
        <div className="control-health"><span className={`health-dot ${trace.run.status === "completed" ? "ready" : "waiting"}`} /><div><strong>{trace.run.mode} · {trace.run.model_alias}</strong><small>{formatDate(trace.run.created_at)} → {formatDate(trace.run.finished_at)}</small></div></div>
      </header>

      <div className="control-metrics">
        <article><span>Run status</span><strong>{trace.run.status}</strong><small>{trace.run.failure_code ?? "no failure"}</small></article>
        <article><span>Risk</span><strong>{task.risk ?? "—"}</strong><small>{task.complexity ?? "unknown"} complexity</small></article>
        <article><span>Skills</span><strong>{trace.skills?.length ?? 0}</strong><small>selected for this run</small></article>
        <article><span>Repo indexes</span><strong>{trace.indexes?.length ?? 0}</strong><small>exact revision snapshots</small></article>
        <article><span>Impact rounds</span><strong>{trace.impacts?.length ?? 0}</strong><small>consequence analyses</small></article>
        <article><span>Verify rounds</span><strong>{trace.verifications?.length ?? 0}</strong><small>persisted before completion</small></article>
      </div>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Task intelligence</p><h2>{task.primaryCategory ?? "Unclassified task"}</h2></div><span className={`status-badge ${riskClass(task.risk)}`}>{task.risk ?? "unknown"}</span></div>
        <div className="provider-grid">
          <article><div><strong>Categories</strong></div><p>{task.categories?.join(" · ") || "—"}</p></article>
          <article><div><strong>Verification requirements</strong></div><p>{task.verificationRequirements?.join(" · ") || "response integrity only"}</p></article>
          <article><div><strong>Runtime requirements</strong></div><p>{[task.requiresBrowser && "browser", task.requiresDatabase && "database", task.requiresSecurityReview && "security review", task.requiresDeployment && "deployment"].filter(Boolean).join(" · ") || "standard"}</p></article>
          <article><div><strong>Recorded</strong></div><p>{formatDate(trace.intelligence?.updated_at)}</p></article>
        </div>
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Skills</p><h2>Activation order</h2></div><span className="panel-count">{trace.skills?.length ?? 0}</span></div>
        {trace.skills?.length ? <div className="compact-list">{trace.skills.map((skill) => <div className="compact-row" key={skill.skill_key}><div><strong>{String(skill.activation_order).padStart(2, "0")} · {skill.skill_key}</strong><small>{formatDate(skill.created_at)}</small></div><span className={`status-badge ${statusClass(skill.status)}`}>{skill.status}</span></div>)}</div> : <p className="empty-state">No persisted skill selection.</p>}
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Repository intelligence</p><h2>Revision lineage</h2></div><span className="panel-count">{trace.indexes?.length ?? 0}</span></div>
        {trace.indexes?.length ? <div className="compact-list">{trace.indexes.map((index) => <div className="compact-row" key={index.id}><div><strong>{index.phase} · {index.repository}</strong><small>{index.ref} · git {shortSha(index.revision_sha)} · content {shortSha(index.content_revision_hash)} · {index.node_count} nodes · {index.edge_count} edges · {index.counts?.files ?? 0} files</small></div><div className="align-right"><span className={`status-badge ${statusClass(index.status)}`}>{index.complete ? "complete" : index.status}</span><small>{formatDate(index.finished_at)}</small></div></div>)}</div> : <p className="empty-state">This run has no repository snapshot.</p>}
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Consequence engine</p><h2>Affected graph</h2></div><span className="panel-count">{trace.impacts?.length ?? 0}</span></div>
        {trace.impacts?.length ? trace.impacts.map((impact) => <article key={impact.id} style={{ marginBottom: 20 }}>
          <div className="control-section-head"><div><h3>Round {impact.verification_round + 1}</h3><p>{impact.changed_count} changed · {impact.affected_count} affected · {impact.test_count} tests</p></div><span className={`status-badge ${riskClass(impact.risk)}`}>{impact.risk}</span></div>
          <div className="compact-list">{impact.nodes.slice(0, 80).map((node) => <div className="compact-row" key={`${node.node_key}:${node.direction}`}><div><strong>{node.kind} · {node.path ?? node.node_key}</strong><small>{node.direction} · distance {node.distance}{node.via ? ` · via ${node.via}` : ""}</small></div></div>)}</div>
          {impact.nodes.length > 80 ? <p className="empty-state">Showing 80 of {impact.nodes.length} affected nodes.</p> : null}
        </article>) : <p className="empty-state">No mutation impact was recorded.</p>}
      </section>

      <section className="control-panel">
        <div className="control-section-head"><div><p className="eyebrow">Completion gate</p><h2>Verification rounds</h2></div><span className="panel-count">{trace.verifications?.length ?? 0}</span></div>
        {trace.verifications?.length ? trace.verifications.map((verification) => <article key={verification.id} style={{ marginBottom: 24 }}>
          <div className="control-section-head"><div><h3>Round {verification.verification_round + 1}</h3><p>{verification.reviewer?.reason ?? "No separate reviewer required"}</p></div><span className={`status-badge ${statusClass(verification.status)}`}>{verification.status}</span></div>
          {verification.blockers?.length ? <div className="compact-list" style={{ marginBottom: 14 }}>{verification.blockers.map((blocker) => <div className="compact-row" key={blocker}><div><strong>Blocker</strong><small>{blocker}</small></div><span className="status-badge status-failed">blocked</span></div>)}</div> : null}
          <div className="compact-list">{verification.results.map((result) => <div className="compact-row" key={result.check_kind}><div><strong>{result.check_kind}{result.required ? " · required" : ""}</strong><small>{result.summary}</small>{result.evidence?.length ? <small>Evidence: {result.evidence.slice(0, 8).join(" · ")}</small> : null}</div><div className="align-right"><span className={`status-badge ${statusClass(result.status)}`}>{result.status}</span><small>{result.duration_ms == null ? "—" : `${result.duration_ms} ms`}</small></div></div>)}</div>
        </article>) : <p className="empty-state">No verification round persisted.</p>}
      </section>
    </div>
  </main>;
}
