// All dynamic text goes through textContent. Findings can contain text copied from the tested site.
const $app = document.getElementById("app");
const $agent = document.getElementById("agent-status");
let timer = null;

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { code: body.code });
  return body;
};
const fmtMs = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const stateClass = { confirmed: "bad", suspected: "warn", observed: "info", dismissed: "" };
const outcomeLabel = { passed: ["Passed", "ok"], failed: ["Defects confirmed", "bad"], blocked: ["Blocked", "warn"], incomplete: ["Incomplete", "warn"] };

async function refreshAgent() {
  try {
    const c = await api("/api/config");
    $agent.textContent = c.agent === "ready" ? "agent ready" : "agent offline";
    $agent.className = "pill " + (c.agent === "ready" ? "ok" : "bad");
    return c;
  } catch {
    $agent.textContent = "ui error";
    $agent.className = "pill bad";
    return null;
  }
}

/* ---------------- start ---------------- */
async function startScreen() {
  const cfg = await refreshAgent();
  const url = el("input", { id: "url", type: "url", placeholder: "http://127.0.0.1:4173", required: true });
  const obj = el("textarea", { id: "obj", placeholder: "e.g. Verify signup, project creation and renaming, navigation and the contact form work as a user expects.", required: true });
  const con = el("textarea", { id: "con", placeholder: "Optional: areas to avoid, test accounts to use, anything else the testers should know." });
  const err = el("div", { class: "error", role: "alert" });
  const btn = el("button", { type: "submit" }, "Start test run");
  const form = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      try {
        const r = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url.value, objective: obj.value, constraints: con.value }) });
        location.hash = `#/run/${r.runId}`;
      } catch (x) {
        err.textContent = x.message;
        btn.disabled = false;
      }
    },
  },
    el("label", { for: "url" }, "Website URL"), url,
    el("div", { class: "hint" }, cfg?.allowedOrigins?.length ? `Authorised origins: ${cfg.allowedOrigins.join(", ")}` : "No origins are authorised yet. Set GHOST_USER_ALLOWED_ORIGINS and restart."),
    el("label", { for: "obj" }, "Testing objective"), obj,
    el("label", { for: "con" }, "Constraints"), con,
    el("div", { class: "hint" }, cfg?.secretNames?.length ? `Credentials available to the testers by name: ${cfg.secretNames.join(", ")} (values are never shown to the model).` : "No credentials configured (GHOST_USER_SECRETS). Testers will only use public pages and sign-up."),
    el("div", { style: "margin-top:20px" }, btn), err);
  const recent = el("div");
  api("/api/runs").then((runs) => {
    if (!runs.length) return;
    recent.append(el("h2", {}, "Recent runs"), el("table", {},
      el("tbody", {}, runs.map((r) => el("tr", {},
        el("td", {}, el("a", { href: `#/run/${r.runId}` }, r.runId)),
        el("td", {}, r.url), el("td", {}, r.objective),
        el("td", {}, el("span", { class: "pill " + (r.finished ? (r.outcome === "objective_satisfied" ? "ok" : "warn") : "info") }, r.finished ? r.outcome : "running")))))));
  }).catch(() => {});
  $app.replaceChildren(el("h1", {}, "Test a website like a user would."), el("p", { class: "lead" }, "Give Ghost User a URL and an objective. Four specialist agents explore, test, investigate and report, with evidence for every claim."), form, recent);
}

/* ---------------- run ---------------- */
function progressBar(value, max) {
  return el("div", { class: "bar", role: "progressbar", "aria-valuenow": value, "aria-valuemax": max }, el("i", { style: `width:${Math.min(100, (value / Math.max(1, max)) * 100)}%` }));
}

function renderRun(v) {
  const c = v.counters;
  const done = v.finished;
  const suspected = v.findings.filter((f) => f.state === "suspected" || f.state === "observed");
  const confirmed = v.findings.filter((f) => f.state === "confirmed");
  const head = el("div", {},
    el("div", { class: "row" },
      el("h1", { style: "margin:0" }, done ? "Run finished" : "Testing in progress"),
      done ? el("span", { class: "pill " + (v.outcome === "objective_satisfied" ? "ok" : "warn") }, v.outcome) : el("span", {}, el("span", { class: "spin" }), "running")),
    el("p", { class: "lead" }, v.url, " — ", v.objective));
  const stats = el("div", { class: "grid" },
    ...[["Agent invocations", `${c.agentInvocations}/${v.budgets.maxAgentInvocations}`], ["Browser actions", c.browserActions], ["Tool calls", c.toolCalls], ["Elapsed", fmtMs(v.elapsedMs)],
      ["Suspected failures", suspected.length], ["Confirmed", confirmed.length]].map(([l, n]) => el("div", { class: "card stat" }, el("div", { class: "n" }, n), el("div", { class: "l" }, l))));
  const active = v.activeTask
    ? el("div", { class: "card" }, el("div", { class: "row" }, el("span", { class: "pill info" }, v.activeTask.role), el("strong", {}, v.activeTask.taskId)),
        el("p", { style: "margin:8px 0" }, v.activeTask.task), el("div", { class: "hint" }, `Browser actions in this task: ${v.activeTask.browserActions}/${v.budgets.maxBrowserActionsPerTask}`), progressBar(v.activeTask.browserActions, v.budgets.maxBrowserActionsPerTask))
    : el("div", { class: "card hint" }, done ? "No active task." : "Waiting for the orchestrator to delegate the next task…");
  const planDone = (id) => v.checks.filter((k) => k.planStepId === id);
  const plan = v.plan.length
    ? el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Plan step"), el("th", {}, "Checks"))),
        el("tbody", {}, v.plan.map((s) => el("tr", {}, el("td", {}, s.title), el("td", {}, planDone(s.id).map((k) => el("span", { class: "pill " + (k.status === "passed" ? "ok" : k.status === "failed" ? "bad" : "warn"), style: "margin-right:4px" }, k.status)), planDone(s.id).length ? null : el("span", { class: "hint" }, "not run yet"))))))
    : el("div", { class: "hint" }, "No plan saved yet.");
  const suspectedList = suspected.length
    ? suspected.map((f) => el("div", { class: "card" }, el("div", { class: "row" }, el("span", { class: "pill " + stateClass[f.state] }, f.state), el("strong", {}, f.title)), el("div", { class: "hint" }, f.observed)))
    : el("div", { class: "hint" }, "None so far.");
  const timeline = el("ol", { class: "timeline", "aria-label": "Browser timeline" },
    [...v.timeline].reverse().map((a) => el("li", {}, el("span", { class: "tl-id" }, a.id), el("span", { class: "tl-role" }, a.role ?? ""), el("span", { class: a.ok ? "" : "tl-bad" }, a.summary))));
  const actions = el("div", { class: "row", style: "margin-top:20px" },
    !done ? el("button", { class: "secondary", onclick: async () => { await api(`/api/runs/${v.runId}/cancel`, { method: "POST" }); } }, "Stop run") : null,
    v.hasReport ? el("a", { class: "btn", href: `#/run/${v.runId}/results` }, "View results") : null);
  $app.replaceChildren(head, stats, el("div", { class: "split" },
    el("div", {}, el("h2", {}, "Current task"), active, el("h2", {}, "Plan"), plan, el("h2", {}, "Suspected failures"), suspectedList),
    el("div", {}, el("h2", {}, "Browser timeline"), timeline)), actions);
}

async function runScreen(runId) {
  await refreshAgent();
  const tick = async () => {
    try {
      const v = await api(`/api/runs/${runId}`);
      if (v.finished && v.hasReport) { location.hash = `#/run/${runId}/results`; return; }
      renderRun(v);
      timer = setTimeout(tick, v.finished ? 2000 : 1000);
    } catch (e) {
      $app.replaceChildren(el("p", { class: "error" }, e.message));
    }
  };
  await tick();
}

/* ---------------- results ---------------- */
async function resultsScreen(runId) {
  let r;
  try { r = await api(`/api/runs/${runId}/report.json`); } catch (e) { $app.replaceChildren(el("p", { class: "error" }, e.message)); return; }
  const [label, cls] = outcomeLabel[r.outcome.result] ?? [r.outcome.result, ""];
  const shots = (ids) => r.evidence.filter((e) => ids.includes(e.id) && e.kind === "screenshot");
  const c = r.counts, m = r.metrics;
  const findingCard = (f) => el("div", { class: "card finding" },
    el("div", { class: "row" }, el("span", { class: "pill " + stateClass[f.state] }, f.state + (f.inconclusive ? " (inconclusive)" : "")), f.severity ? el("span", { class: "pill" }, f.severity) : null, f.confidence != null ? el("span", { class: "pill" }, `confidence ${Math.round(f.confidence * 100)}%`) : null),
    el("h3", {}, f.title),
    el("dl", {}, el("dt", {}, "Expected"), el("dd", {}, f.expected), el("dt", {}, "Observed"), el("dd", {}, f.observed),
      f.rationale ? [el("dt", {}, "Rationale"), el("dd", {}, f.rationale)] : null,
      f.dismissReason ? [el("dt", {}, "Dismissed because"), el("dd", {}, f.dismissReason)] : null,
      el("dt", {}, "Evidence"), el("dd", { class: "mono" }, (f.reproductionEvidenceIds?.length ? f.reproductionEvidenceIds : f.evidenceIds).join(", "))),
    f.reproductionSteps?.length ? el("div", {}, el("strong", {}, "Reproduction steps"), el("ol", { class: "clean" }, f.reproductionSteps.map((s) => el("li", {}, s)))) : null,
    el("div", { class: "shots" }, shots([...(f.evidenceIds ?? []), ...(f.reproductionEvidenceIds ?? [])]).map((s) => el("a", { href: `/api/runs/${runId}/${s.file}`, target: "_blank", rel: "noopener" }, el("img", { src: `/api/runs/${runId}/${s.file}`, alt: s.summary, loading: "lazy" })))));
  const section = (title, items, empty) => [el("h2", {}, title), ...(items.length ? items : [el("div", { class: "hint" }, empty)])];
  const byState = (s) => r.findings.filter((f) => f.state === s).map(findingCard);
  const checkRows = (st) => r.checks.filter((k) => k.status === st).map((k) => el("tr", {}, el("td", {}, k.title), el("td", {}, k.observed)));
  const checkTable = (rows) => el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Check"), el("th", {}, "Observed"))), el("tbody", {}, rows));
  const passed = checkRows("passed"), blocked = checkRows("blocked");
  $app.replaceChildren(
    el("div", { class: "row" }, el("h1", { style: "margin:0" }, "Results"), el("span", { class: "pill " + cls }, label)),
    el("p", { class: "lead" }, r.target.url, " — ", r.executiveSummary),
    el("div", { class: "grid" }, ...[["Confirmed", c.confirmed], ["Suspected", c.suspected + c.observed], ["Dismissed", c.dismissed], ["Checks passed", c.checksPassed], ["Checks blocked", c.checksBlocked]].map(([l, n]) => el("div", { class: "card stat" }, el("div", { class: "n" }, n), el("div", { class: "l" }, l)))),
    el("div", { class: "row", style: "margin:12px 0" },
      el("a", { class: "btn", href: `/api/runs/${runId}/report.html` }, "Download HTML report"),
      el("a", { class: "btn secondary", href: `/api/runs/${runId}/report.json` }, "Download JSON"),
      el("a", { class: "btn secondary", href: "#/" }, "New run")),
    ...section("Confirmed failures", byState("confirmed"), "No defect was confirmed."),
    ...section("Suspected, not confirmed", [...byState("suspected"), ...byState("observed")], "None."),
    ...section("Dismissed", byState("dismissed"), "None."),
    ...section("Passed checks", passed.length ? [checkTable(passed)] : [], "None."),
    ...section("Blocked checks", blocked.length ? [checkTable(blocked)] : [], "None."),
    el("h2", {}, "Efficiency"),
    el("div", { class: "card" }, el("div", { class: "grid" },
      ...[["Agent invocations", m.agentInvocations], ["Tool calls", m.toolCalls], ["Browser actions", m.browserActions], ["Runtime", fmtMs(m.runtimeMs)],
        ["Tokens", m.model ? (m.model.totalTokens ?? (m.model.inputTokens ?? 0) + (m.model.outputTokens ?? 0)).toLocaleString() : "not reported"], ["Cost", m.model?.costUsd != null ? `$${m.model.costUsd.toFixed(4)}` : "not reported"]]
        .map(([l, n]) => el("div", { class: "stat" }, el("div", { class: "n" }, n), el("div", { class: "l" }, l))))));
}

/* ---------------- router ---------------- */
function route() {
  clearTimeout(timer);
  const m = location.hash.match(/^#\/run\/(run-[a-z0-9]+)(\/results)?$/);
  if (m) return m[2] ? resultsScreen(m[1]) : runScreen(m[1]);
  return startScreen();
}
addEventListener("hashchange", route);
route();
