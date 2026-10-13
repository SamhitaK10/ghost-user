import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  QAReportSchema,
  type ActionRecord,
  type Check,
  type Finding,
  type QAReport,
  type RunState,
} from "./schemas";
import type { RunStore } from "./store";
import { truncate } from "./safety";

export interface Narrative {
  executiveSummary?: string;
  groups?: { title: string; findingIds: string[] }[];
}

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Report facts come only from the store. The Reporter agent may contribute narrative text and a
 * grouping; ids are validated here, so a report can never link to evidence or findings that do not exist.
 */
export function buildReport(input: {
  state: RunState;
  checks: Check[];
  findings: Finding[];
  actions: ActionRecord[];
  usage: Record<string, number | undefined> | null;
  narrative?: Narrative;
  now?: Date;
}): QAReport {
  const { state, checks, findings, actions, usage } = input;
  const at = input.now ?? new Date();

  const count = (st: Finding["state"]) => findings.filter((f) => f.state === st).length;
  const counts = {
    checksPassed: checks.filter((c) => c.status === "passed").length,
    checksFailed: checks.filter((c) => c.status === "failed").length,
    checksBlocked: checks.filter((c) => c.status === "blocked").length,
    confirmed: count("confirmed"),
    suspected: count("suspected"),
    observed: count("observed"),
    dismissed: count("dismissed"),
  };

  let result: QAReport["outcome"]["result"];
  if (counts.confirmed > 0) result = "failed";
  else if (counts.suspected + counts.observed > 0) result = "incomplete";
  else if (counts.checksBlocked > 0) result = "blocked";
  else if (state.outcome !== "objective_satisfied") result = "incomplete";
  else result = "passed";

  // Grouping: keep only known finding ids, each in at most one group; ungrouped findings stand alone.
  const known = new Set(findings.map((f) => f.id));
  const used = new Set<string>();
  const groups: QAReport["groups"] = [];
  for (const g of input.narrative?.groups ?? []) {
    const ids = g.findingIds.filter((id) => known.has(id) && !used.has(id));
    ids.forEach((id) => used.add(id));
    if (ids.length > 0) groups.push({ title: truncate(g.title, 120), findingIds: ids });
  }
  for (const f of findings) if (!used.has(f.id)) groups.push({ title: f.title, findingIds: [f.id] });

  const auto =
    `${counts.checksPassed} check(s) passed, ${counts.checksFailed} failed, ${counts.checksBlocked} blocked. ` +
    `${counts.confirmed} defect(s) confirmed, ${counts.suspected + counts.observed} unverified, ${counts.dismissed} dismissed. (Auto-generated summary.)`;
  const executiveSummary = input.narrative?.executiveSummary?.trim() ? truncate(input.narrative.executiveSummary.trim(), 1200) : auto;

  // Evidence index: everything referenced by a check or finding, plus the finding evidence.
  const wanted = new Set<string>();
  for (const c of checks) c.evidenceIds.forEach((e) => wanted.add(e));
  for (const f of findings) {
    f.evidenceIds.forEach((e) => wanted.add(e));
    f.reproductionEvidenceIds?.forEach((e) => wanted.add(e));
  }
  const byId = new Map(actions.map((a) => [a.id, a]));
  const evidence = [...wanted]
    .map((id) => byId.get(id))
    .filter((a): a is ActionRecord => Boolean(a))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => ({ id: a.id, kind: a.kind, tool: a.tool, summary: truncate(a.summary, 200), url: a.url, file: a.file }));

  const end = state.endedAt ? Date.parse(state.endedAt) : at.getTime();
  const model = usage
    ? {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        costUsd: usage.costUsd,
      }
    : null;

  const report: QAReport = {
    schemaVersion: 1,
    runId: state.runId,
    generatedAt: at.toISOString(),
    target: { url: state.url, objective: state.objective },
    outcome: { result, runOutcome: state.outcome, note: state.outcomeNote },
    executiveSummary,
    counts,
    metrics: {
      agentInvocations: state.counters.agentInvocations,
      toolCalls: state.counters.toolCalls,
      browserActions: state.counters.browserActions,
      runtimeMs: Math.max(0, end - Date.parse(state.startedAt)),
      model,
    },
    limits: { budgets: state.budgets, model: state.modelLimits },
    groups,
    findings: [...findings].sort(
      (a, b) => (SEV_ORDER[a.severity ?? "low"] ?? 9) - (SEV_ORDER[b.severity ?? "low"] ?? 9) || a.id.localeCompare(b.id),
    ),
    checks,
    evidence,
  };
  return QAReportSchema.parse(report);
}

/* --------------------------------- HTML rendering ------------------------------------- */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

export function renderHtml(r: QAReport, images: Map<string, string>): string {
  const evById = new Map(r.evidence.map((e) => [e.id, e]));
  const findingsById = new Map(r.findings.map((f) => [f.id, f]));

  const evidenceList = (ids: string[]) =>
    ids.length === 0
      ? '<p class="muted">No evidence ids.</p>'
      : `<div class="evidence">${ids
          .map((id) => {
            const e = evById.get(id);
            const img = images.get(id);
            if (img) {
              return `<figure id="ev-${esc(id)}"><img alt="${esc(id)}" src="${img}"><figcaption><code>${esc(id)}</code> ${esc(e?.summary ?? "")}</figcaption></figure>`;
            }
            return `<div class="ev"><a href="#evidence-${esc(id)}"><code>${esc(id)}</code></a> <span class="muted">${esc(e ? `${e.tool}: ${e.summary}` : "unknown")}</span></div>`;
          })
          .join("")}</div>`;

  const card = (f: Finding) => `
<article class="card ${esc(f.state)}" id="${esc(f.id)}">
 <header><span class="badge ${esc(f.state)}">${esc(f.state)}</span>${f.severity ? `<span class="badge sev-${esc(f.severity)}">${esc(f.severity)}</span>` : ""}${f.confidence !== undefined ? `<span class="muted">confidence ${(f.confidence * 100).toFixed(0)}%</span>` : ""}<h3>${esc(f.title)}</h3></header>
 <dl><dt>Expected</dt><dd>${esc(f.expected)}</dd><dt>Observed</dt><dd>${esc(f.observed)}</dd></dl>
 ${f.rationale ? `<p><strong>Rationale.</strong> ${esc(f.rationale)}</p>` : ""}
 ${f.dismissReason ? `<p class="muted">Dismissed: ${esc(f.dismissReason.replace(/_/g, " "))}</p>` : ""}
 ${f.reproductionSteps?.length ? `<h4>Reproduction steps</h4><ol>${f.reproductionSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
 <h4>Evidence</h4>${evidenceList([...new Set([...(f.reproductionEvidenceIds ?? []), ...f.evidenceIds])])}
</article>`;

  const section = (title: string, states: Finding["state"][], note?: string) => {
    const ids = new Set(r.groups.flatMap((g) => g.findingIds));
    const parts: string[] = [];
    for (const g of r.groups) {
      const fs = g.findingIds.map((id) => findingsById.get(id)).filter((f): f is Finding => !!f && states.includes(f.state));
      if (fs.length === 0) continue;
      parts.push(`${fs.length > 1 ? `<h3 class="group">${esc(g.title)} <span class="muted">(${fs.length} related)</span></h3>` : ""}${fs.map(card).join("")}`);
    }
    void ids;
    return parts.length === 0 ? "" : `<section><h2>${esc(title)}</h2>${note ? `<p class="muted">${esc(note)}</p>` : ""}${parts.join("")}</section>`;
  };

  const checkTable = (status: "passed" | "blocked") => {
    const rows = r.checks.filter((c) => c.status === status);
    if (rows.length === 0) return `<p class="muted">None.</p>`;
    return `<table><thead><tr><th>Check</th><th>Title</th><th>Expected</th><th>Observed</th><th>Evidence</th></tr></thead><tbody>${rows
      .map(
        (c) =>
          `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.title)}</td><td>${esc(c.expected)}</td><td>${esc(c.observed)}</td><td>${c.evidenceIds.map((e) => `<code>${esc(e)}</code>`).join(" ")}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  };

  const m = r.metrics;
  const model = m.model
    ? `${m.model.totalTokens ?? (m.model.inputTokens ?? 0) + (m.model.outputTokens ?? 0)} tokens${m.model.costUsd !== undefined ? `, $${m.model.costUsd.toFixed(4)}` : ""}`
    : "not recorded";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ghost User report ${esc(r.runId)}</title>
<style>
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--card:#fafafa;--red:#c4161c;--amber:#b25e00;--green:#0a7a3c;--blue:#0b5cd5}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--muted:#9a9a9a;--line:#2a2a2a;--card:#111;--red:#ff6369;--amber:#f5a623;--green:#3ecf8e;--blue:#52a8ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 4px} h2{margin:36px 0 12px;font-size:20px;border-bottom:1px solid var(--line);padding-bottom:6px} h3{margin:6px 0;font-size:16px} h4{margin:14px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.muted{color:var(--muted)} code{font:12.5px ui-monospace,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.banner{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;border:1px solid currentColor}
.banner.failed{color:var(--red)} .banner.passed{color:var(--green)} .banner.blocked,.banner.incomplete{color:var(--amber)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.tile{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--card)} .tile b{display:block;font-size:22px}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0;background:var(--card)}
.card.confirmed{border-left:4px solid var(--red)} .card.suspected,.card.observed{border-left:4px solid var(--amber)} .card.dismissed{border-left:4px solid var(--muted)}
.card header{display:flex;flex-wrap:wrap;gap:8px;align-items:center} .card header h3{flex-basis:100%}
.badge{font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
.badge.confirmed,.badge.sev-critical,.badge.sev-high{color:var(--red)} .badge.suspected,.badge.observed,.badge.sev-medium{color:var(--amber)} .badge.dismissed,.badge.sev-low{color:var(--muted)}
dl{display:grid;grid-template-columns:90px 1fr;gap:4px 12px;margin:8px 0} dt{color:var(--muted)} dd{margin:0}
table{width:100%;border-collapse:collapse;font-size:13px} th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.evidence{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px} figure{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden} figure img{width:100%;display:block} figcaption{padding:6px 8px;font-size:12px}
.ev{font-size:13px}
</style></head><body><main>
<h1>Ghost User QA report</h1>
<p class="muted">Run <code>${esc(r.runId)}</code> &middot; ${esc(r.generatedAt)}</p>
<p><span class="banner ${esc(r.outcome.result)}">${esc(r.outcome.result.toUpperCase())}</span>${r.outcome.runOutcome ? ` <span class="muted">run outcome: ${esc(r.outcome.runOutcome.replace(/_/g, " "))}</span>` : ""}</p>
<p><strong>Target:</strong> ${esc(r.target.url)}<br><strong>Objective:</strong> ${esc(r.target.objective)}</p>
${r.outcome.note ? `<p class="muted">${esc(r.outcome.note)}</p>` : ""}
<h2>Summary</h2><p>${esc(r.executiveSummary)}</p>
<div class="tiles">
 <div class="tile"><b>${r.counts.confirmed}</b>confirmed defects</div>
 <div class="tile"><b>${r.counts.suspected + r.counts.observed}</b>unverified failures</div>
 <div class="tile"><b>${r.counts.checksPassed}</b>passed checks</div>
 <div class="tile"><b>${r.counts.checksBlocked}</b>blocked checks</div>
 <div class="tile"><b>${r.counts.dismissed}</b>dismissed</div>
</div>
<table><tbody>
 <tr><th>Agent invocations</th><td>${m.agentInvocations} (limit ${r.limits.budgets.maxAgentInvocations}, reporter exempt)</td></tr>
 <tr><th>Tool calls</th><td>${m.toolCalls}</td></tr>
 <tr><th>Browser actions</th><td>${m.browserActions} (limit ${r.limits.budgets.maxBrowserActionsPerTask} per task)</td></tr>
 <tr><th>Runtime</th><td>${fmtMs(m.runtimeMs)} (limit ${fmtMs(r.limits.budgets.maxElapsedMs)})</td></tr>
 <tr><th>Model usage</th><td>${esc(model)}</td></tr>
</tbody></table>
${section("Confirmed failures", ["confirmed"], "Reproduced by the Investigator in a fresh task with its own evidence.")}
${section("Unverified failures", ["suspected", "observed"], "NOT confirmed. These were observed or suspected by the Tester but not reproduced. Treat as leads, not defects.")}
${section("Dismissed", ["dismissed"], "Investigated and judged not to be product defects.")}
<section><h2>Passed checks</h2>${checkTable("passed")}</section>
<section><h2>Blocked checks</h2>${checkTable("blocked")}</section>
<section><h2>Evidence index</h2>${
    r.evidence.length === 0
      ? '<p class="muted">None.</p>'
      : `<table><thead><tr><th>Id</th><th>Kind</th><th>Tool</th><th>Summary</th><th>URL</th></tr></thead><tbody>${r.evidence
          .map((e) => `<tr id="evidence-${esc(e.id)}"><td><code>${esc(e.id)}</code></td><td>${esc(e.kind)}</td><td>${esc(e.tool)}</td><td>${esc(e.summary)}</td><td>${esc(e.url ?? "")}</td></tr>`)
          .join("")}</tbody></table>`
  }</section>
</main></body></html>`;
}

const MAX_EMBED_BYTES = 400_000;

export async function writeReport(
  store: RunStore,
  runId: string,
  narrative?: Narrative,
): Promise<{ report: QAReport; htmlPath: string; jsonPath: string }> {
  const [state, checks, findings, actions, usage] = await Promise.all([
    store.getState(runId),
    store.getChecks(runId),
    store.getFindings(runId),
    store.listActions(runId),
    store.getUsage(runId),
  ]);
  const report = buildReport({ state, checks, findings, actions, usage, narrative });
  const images = new Map<string, string>();
  for (const e of report.evidence) {
    if (e.kind !== "screenshot" || !e.file || images.size >= 12) continue;
    try {
      const buf = await readFile(join(store.runDir(runId), e.file));
      if (buf.length <= MAX_EMBED_BYTES) images.set(e.id, `data:image/jpeg;base64,${buf.toString("base64")}`);
    } catch {
      // missing file: the evidence row still renders
    }
  }
  const htmlPath = join(store.runDir(runId), "report.html");
  const jsonPath = join(store.runDir(runId), "report.json");
  await writeFile(htmlPath, renderHtml(report, images));
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  return { report, htmlPath, jsonPath };
}
