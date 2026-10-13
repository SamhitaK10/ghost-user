import { z } from "zod";
import * as B from "../core/browser";
import { closeRunBrowser } from "../core/browser";
import { loadSecrets } from "../core/redact";
import { parseAllowedOrigins, truncate } from "../core/safety";
import { secretNames } from "../core/redact";
import { writeReport, type Narrative } from "../core/report";
import {
  DismissReasonSchema,
  PlanStepSchema,
  RunIdSchema,
  SeveritySchema,
  CheckStatusSchema,
  type Role,
} from "../core/schemas";
import { browserFor, failure, getStore, guarded, refusal, type Failure } from "./runtime";

const BROWSER_ROLES: readonly Role[] = ["explorer", "tester", "investigator"];
const WRITE_ROLES: readonly Role[] = ["tester", "investigator"];

export const runIdField = RunIdSchema.describe("The RUN id from your task message, e.g. run-1a2b3c4d5e6f.");

/** Run a browser action: guard -> act -> record evidence -> return a compact result with its evidence id. */
async function browserAction<R extends { ok: boolean }>(
  runId: string,
  tool: string,
  roles: readonly Role[],
  input: unknown,
  act: (rb: B.RunBrowser, taskId: string | null) => Promise<R>,
  summarize: (r: R) => string,
): Promise<(R & { evidenceId: string }) | Failure> {
  return guarded(runId, { kind: "browser", allowedRoles: roles }, async (g) => {
    const store = getStore();
    const rb = await browserFor(runId);
    const t0 = Date.now();
    const result = await act(rb, g.taskId);
    const failed = !result.ok ? (result as unknown as Failure) : null;
    const rec = await store.recordAction(runId, {
      kind: "action",
      taskId: g.taskId,
      role: g.role,
      tool,
      input,
      summary: rb.redact(truncate(failed ? `FAILED ${failed.code}: ${failed.reason}` : summarize(result), 200)),
      ok: result.ok,
      url: rb.redact(rb.page.url()),
      durationMs: Date.now() - t0,
      errorCode: failed?.code,
    });
    return { ...result, evidenceId: rec.id };
  });
}

export const BrowserTools = {
  async open(a: { runId: string; url: string }) {
    return browserAction(a.runId, "browser_open", BROWSER_ROLES, { url: a.url }, (rb) => B.open(rb, a.url), (r) => `open -> ${(r as { url?: string }).url}`);
  },
  async reload(a: { runId: string }) {
    return browserAction(a.runId, "browser_reload", BROWSER_ROLES, {}, (rb) => B.reload(rb), (r) => `reload -> ${(r as { url?: string }).url}`);
  },
  async snapshot(a: { runId: string; scope?: B.SnapshotScope; maxElements?: number; contains?: string }) {
    return browserAction(
      a.runId,
      "browser_snapshot",
      BROWSER_ROLES,
      { scope: a.scope, maxElements: a.maxElements, contains: a.contains },
      async (rb, taskId) => {
        const r = await B.snapshot(rb, { taskId, scope: a.scope, maxElements: a.maxElements, contains: a.contains });
        return ("code" in r ? r : { ok: true as const, ...r }) as (B.SnapshotResult & { ok: true }) | B.BrowserFailure;
      },
      (r) => {
        const s = r as unknown as B.SnapshotResult;
        return `snapshot ${s.url} (${s.shown}/${s.total} elements${s.unchanged ? ", unchanged" : s.cached ? ", cached" : ""})`;
      },
    );
  },
  async click(a: { runId: string; ref: string }) {
    return browserAction(a.runId, "browser_click", BROWSER_ROLES, { ref: a.ref }, (rb) => B.click(rb, a.ref, { navigationalOnly: false }), (r) => `click ${(r as { clicked?: string }).clicked} -> ${(r as { url?: string }).url}`);
  },
  async fill(a: { runId: string; ref: string; value?: string; secretName?: string }) {
    // Only the secret NAME is recorded; plain values are redacted/truncated in the log.
    return browserAction(
      a.runId,
      "browser_fill",
      WRITE_ROLES,
      { ref: a.ref, secretName: a.secretName, value: a.value === undefined ? undefined : truncate(a.value, 40) },
      (rb) => B.fill(rb, a.ref, { value: a.value, secretName: a.secretName }),
      (r) => `fill ${(r as { filled?: string }).filled}${a.secretName ? ` with secret:${a.secretName}` : ""}`,
    );
  },
  async press(a: { runId: string; key: string }) {
    return browserAction(a.runId, "browser_press", WRITE_ROLES, { key: a.key }, (rb) => B.press(rb, a.key), () => `press ${a.key}`);
  },
  async readText(a: { runId: string; ref?: string; maxChars?: number }) {
    const out = await browserAction(
      a.runId,
      "browser_read_text",
      BROWSER_ROLES,
      { ref: a.ref, maxChars: a.maxChars },
      (rb) => B.readText(rb, { ref: a.ref, maxChars: Math.min(a.maxChars ?? 1200, 2000) }),
      (r) => `read_text ${(r as { totalChars?: number }).totalChars} chars`,
    );
    if (!out.ok || !(out as { truncated?: boolean }).truncated) return out;
    // Overflow goes to an artifact the agent can page through, never into context.
    try {
      const rb = await browserFor(a.runId);
      const full = rb.redact(await B.fullBodyText(rb));
      const artifactId = await getStore().saveArtifact(a.runId, full);
      return { ...out, artifactId };
    } catch {
      return out;
    }
  },
  async log(a: { runId: string; kind: "console" | "network"; since?: number; limit?: number }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: BROWSER_ROLES }, async (g) => {
      const rb = await browserFor(a.runId);
      const r = B.readLog(rb, a.kind, a.since ?? 0, Math.min(a.limit ?? 15, 30));
      const rec = await getStore().recordAction(a.runId, {
        kind: "tool",
        taskId: g.taskId,
        role: g.role,
        tool: `browser_${a.kind}`,
        input: { since: a.since },
        summary: `${a.kind} log: ${r.entries.length} of ${r.total} entries`,
        ok: true,
        url: rb.page.url(),
      });
      return { ok: true as const, ...r, evidenceId: rec.id };
    });
  },
  async screenshot(a: { runId: string; label?: string }) {
    return guarded(a.runId, { kind: "browser", allowedRoles: BROWSER_ROLES }, async (g) => {
      const store = getStore();
      const rb = await browserFor(a.runId);
      const bytes = await B.screenshotJpeg(rb);
      const saved = await store.saveScreenshot(a.runId, bytes);
      await store.recordAction(a.runId, {
        id: saved.id,
        kind: "screenshot",
        taskId: g.taskId,
        role: g.role,
        tool: "browser_screenshot",
        summary: truncate(`screenshot of ${rb.page.url()}${a.label ? ` (${a.label})` : ""}`, 200),
        ok: true,
        url: rb.page.url(),
        file: saved.file,
      });
      return { ok: true as const, evidenceId: saved.id, url: rb.page.url(), note: "Screenshots are evidence for the report; they are not shown to you." };
    });
  },
};

export const RecordTools = {
  async recordCheck(a: {
    runId: string;
    planStepId?: string;
    title: string;
    expected: string;
    observed: string;
    status: z.infer<typeof CheckStatusSchema>;
    evidenceIds: string[];
    suspectsProductDefect?: boolean;
  }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: ["tester"] }, async () => {
      const { runId, ...rest } = a;
      const r = await getStore().addCheck(runId, rest);
      if (!r.ok) return refusal(r);
      return { ok: true as const, checkId: r.check.id, status: r.check.status, findingId: r.finding?.id, findingState: r.finding?.state };
    });
  },
  async markSuspected(a: { runId: string; findingId: string }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: ["tester"] }, async () => {
      const r = await getStore().markSuspected(a.runId, a.findingId);
      return r.ok ? { ok: true as const, findingId: r.finding.id, state: r.finding.state } : refusal(r);
    });
  },
  async getFinding(a: { runId: string; findingId: string }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: ["investigator", "reporter"] }, async () => {
      const store = getStore();
      const f = (await store.getFindings(a.runId)).find((x) => x.id === a.findingId);
      if (!f) return { ok: false as const, code: "UNKNOWN_FINDING", reason: `No finding ${a.findingId}.` };
      const idx = await store.evidenceIndex(a.runId);
      const evidence = f.evidenceIds.slice(0, 8).map((id) => {
        const e = idx.get(id);
        return e ? { id, tool: e.tool, summary: e.summary, url: e.url, ok: e.ok } : { id, summary: "(check or unknown)" };
      });
      return { ok: true as const, finding: f, evidence };
    });
  },
  async recordVerdict(a: {
    runId: string;
    findingId: string;
    verdict: "confirmed" | "dismissed" | "inconclusive";
    confidence: number;
    severity?: z.infer<typeof SeveritySchema>;
    reproductionSteps?: string[];
    reproductionEvidenceIds?: string[];
    rationale: string;
    dismissReason?: z.infer<typeof DismissReasonSchema>;
  }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: ["investigator"] }, async () => {
      const { runId, ...rest } = a;
      const r = await getStore().recordVerdict(runId, rest);
      return r.ok ? { ok: true as const, findingId: r.finding.id, state: r.finding.state } : refusal(r);
    });
  },
  async readArtifact(a: { runId: string; artifactId: string; offset?: number; limit?: number }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: BROWSER_ROLES }, async () => {
      const r = await getStore().readArtifact(a.runId, a.artifactId, a.offset ?? 0, a.limit ?? 2000);
      return { ok: true as const, ...r, offset: a.offset ?? 0 };
    });
  },
};

export const ReporterTools = {
  async context(a: { runId: string }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: ["reporter"] }, async () => {
      const store = getStore();
      const [state, checks, findings] = await Promise.all([store.getState(a.runId), store.getChecks(a.runId), store.getFindings(a.runId)]);
      return {
        ok: true as const,
        target: state.url,
        objective: truncate(state.objective, 300),
        runOutcome: state.outcome ?? "in_progress",
        checks: checks.slice(0, 40).map((c) => ({ id: c.id, status: c.status, title: truncate(c.title, 90) })),
        findings: findings.slice(0, 30).map((f) => ({
          id: f.id,
          state: f.state,
          severity: f.severity,
          title: truncate(f.title, 90),
          inconclusive: f.inconclusive,
        })),
      };
    });
  },
  async write(a: { runId: string; executiveSummary?: string; groups?: { title: string; findingIds: string[] }[] }) {
    return guarded(a.runId, { kind: "tool", allowedRoles: ["reporter"] }, async () => {
      const narrative: Narrative = { executiveSummary: a.executiveSummary, groups: a.groups };
      await getStore().saveNarrative(a.runId, narrative);
      const { report, htmlPath } = await writeReport(getStore(), a.runId, narrative);
      return {
        ok: true as const,
        result: report.outcome.result,
        counts: report.counts,
        htmlPath,
        note: "Facts in the report come from the run store; your narrative was validated against real finding ids.",
      };
    });
  },
};

export const OrchestratorTools = {
  async startRun(a: { url: string; objective: string; constraints?: string }, sessionId?: string) {
    try {
      const store = getStore();
      const state = await store.createRun({
        url: a.url,
        objective: a.objective,
        constraints: a.constraints,
        sessionId,
        allowedOrigins: parseAllowedOrigins(),
        secretNames: secretNames(loadSecrets()),
      });
      return { ok: true as const, runId: state.runId, budgets: state.budgets, secretNames: state.secretNames };
    } catch (e) {
      return failure(e);
    }
  },
  async savePlan(a: { runId: string; steps: { id: string; title: string; expectedOutcome: string }[] }) {
    try {
      const steps = a.steps.map((s) => PlanStepSchema.parse(s));
      const plan = await getStore().savePlan(a.runId, { steps });
      return { ok: true as const, steps: plan.steps.length };
    } catch (e) {
      return failure(e);
    }
  },
  async status(a: { runId: string }) {
    try {
      const store = getStore();
      const [s, checks, findings] = await Promise.all([store.getState(a.runId), store.getChecks(a.runId), store.getFindings(a.runId)]);
      const count = (st: string) => findings.filter((f) => f.state === st).length;
      return {
        ok: true as const,
        finished: Boolean(s.endedAt),
        activeTask: s.activeTaskId,
        counters: s.counters,
        remaining: {
          agentInvocations: Math.max(0, s.budgets.maxAgentInvocations - s.tasks.filter((t) => t.role !== "reporter").length),
          elapsedMs: Math.max(0, s.budgets.maxElapsedMs - (Date.now() - Date.parse(s.startedAt))),
        },
        checks: {
          passed: checks.filter((c) => c.status === "passed").length,
          failed: checks.filter((c) => c.status === "failed").length,
          blocked: checks.filter((c) => c.status === "blocked").length,
        },
        findings: { observed: count("observed"), suspected: count("suspected"), confirmed: count("confirmed"), dismissed: count("dismissed") },
        tasks: s.tasks.slice(-8).map((t) => ({ taskId: t.taskId, role: t.role, status: t.status, summary: t.summary })),
      };
    } catch (e) {
      return failure(e);
    }
  },
  async finish(a: { runId: string; outcome: "objective_satisfied" | "blocked" | "budget_exhausted" | "failed"; note?: string }) {
    try {
      const store = getStore();
      const state = await store.finishRun(a.runId, a.outcome, a.note);
      // A report is ALWAYS produced from stored facts, even if the Reporter agent failed or was skipped.
      const narrative = await store.getNarrative<Narrative>(a.runId);
      const { report, htmlPath, jsonPath } = await writeReport(store, a.runId, narrative ?? undefined);
      await closeRunBrowser(a.runId);
      return { ok: true as const, outcome: state.outcome, result: report.outcome.result, counts: report.counts, htmlPath, jsonPath };
    } catch (e) {
      return failure(e);
    }
  },
};
