import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/core/store";
import { newRun, startTask, tempStore, ORIGIN } from "./helpers";

let ctx: Awaited<ReturnType<typeof tempStore>>;
beforeEach(async () => (ctx = await tempStore()));
afterEach(async () => ctx.cleanup());

describe("run creation", () => {
  it("refuses unauthorised targets", async () => {
    await expect(ctx.store.createRun({ url: "http://evil.test/", objective: "x", allowedOrigins: [ORIGIN], env: {} })).rejects.toBeInstanceOf(StoreError);
  });
  it("persists state across store instances (state survives a restart)", async () => {
    const run = await newRun(ctx.store);
    const again = new (ctx.store.constructor as typeof import("../src/core/store").RunStore)(ctx.dir);
    expect((await again.getState(run.runId)).objective).toBe(run.objective);
  });
  it("rejects path-like run ids", async () => {
    expect(() => ctx.store.runDir("../etc")).toThrow();
  });
});

describe("delegation budgets and retries (enforced in code)", () => {
  it("allows a single active task", async () => {
    const { runId } = await newRun(ctx.store);
    await startTask(ctx.store, runId, "explorer");
    const second = await ctx.store.reserveTask({ runId, role: "tester", task: "other" });
    expect(second).toMatchObject({ ok: false, code: "TASK_IN_PROGRESS" });
  });
  it("de-duplicates a completed task and returns its prior summary", async () => {
    const { runId } = await newRun(ctx.store);
    const t = await startTask(ctx.store, runId, "explorer", "map site", "explore-all");
    await ctx.store.settleTask(runId, t, "completed", { status: "completed", summary: "mapped 4 pages", evidenceIds: [], suspectedFailures: 0, nextAction: "test" });
    const again = await ctx.store.reserveTask({ runId, role: "explorer", task: "map site again", taskKey: "explore-all" });
    expect(again).toMatchObject({ ok: false, code: "ALREADY_COMPLETED", previous: { summary: "mapped 4 pages" } });
  });
  it("allows exactly maxTaskRetries retries of a failed task, then refuses", async () => {
    const { runId } = await newRun(ctx.store, { maxTaskRetries: 1 });
    const a = await startTask(ctx.store, runId, "tester", "t", "k");
    await ctx.store.settleTask(runId, a, "failed");
    const b = await startTask(ctx.store, runId, "tester", "t", "k"); // the one allowed retry
    await ctx.store.settleTask(runId, b, "failed");
    expect(await ctx.store.reserveTask({ runId, role: "tester", task: "t", taskKey: "k" })).toMatchObject({ ok: false, code: "RETRY_LIMIT" });
  });
  it("enforces maxAgentInvocations but still lets the reporter run", async () => {
    const { runId } = await newRun(ctx.store, { maxAgentInvocations: 2 });
    for (const k of ["a", "b"]) {
      const t = await startTask(ctx.store, runId, "tester", k, k);
      await ctx.store.settleTask(runId, t, "completed");
    }
    expect(await ctx.store.reserveTask({ runId, role: "tester", task: "c", taskKey: "c" })).toMatchObject({ ok: false, code: "INVOCATION_LIMIT" });
    expect((await ctx.store.reserveTask({ runId, role: "reporter", task: "report" })).ok).toBe(true);
  });
  it("enforces delegation depth", async () => {
    const { runId } = await newRun(ctx.store, { maxDelegationDepth: 1 });
    expect(await ctx.store.reserveTask({ runId, role: "tester", task: "deep", depth: 2 })).toMatchObject({ ok: false, code: "DEPTH_LIMIT" });
  });
  it("enforces the elapsed-time budget for non-reporter roles", async () => {
    const { runId } = await newRun(ctx.store, { maxElapsedMs: 1000 });
    await ctx.store.mutate(runId, (s) => {
      s.startedAt = new Date(Date.now() - 60_000).toISOString();
    });
    expect(await ctx.store.reserveTask({ runId, role: "tester", task: "late" })).toMatchObject({ ok: false, code: "RUN_TIMEOUT" });
    expect((await ctx.store.reserveTask({ runId, role: "reporter", task: "report" })).ok).toBe(true);
  });
  it("refuses delegation after the run finished", async () => {
    const { runId } = await newRun(ctx.store);
    await ctx.store.finishRun(runId, "objective_satisfied");
    expect(await ctx.store.reserveTask({ runId, role: "tester", task: "x" })).toMatchObject({ ok: false, code: "RUN_FINISHED" });
  });
});

describe("tool-call budgets", () => {
  it("requires an active task and respects the role allowlist", async () => {
    const { runId } = await newRun(ctx.store);
    expect(await ctx.store.beginToolCall(runId, { kind: "browser", requireTask: true })).toMatchObject({ ok: false, code: "NO_ACTIVE_TASK" });
    await startTask(ctx.store, runId, "explorer");
    expect(await ctx.store.beginToolCall(runId, { kind: "tool", requireTask: true, allowedRoles: ["tester"] })).toMatchObject({ ok: false, code: "ROLE_NOT_ALLOWED" });
  });
  it("caps browser actions per task and counts them", async () => {
    const { runId } = await newRun(ctx.store, { maxBrowserActionsPerTask: 3 });
    await startTask(ctx.store, runId, "tester");
    for (let i = 0; i < 3; i++) expect((await ctx.store.beginToolCall(runId, { kind: "browser", requireTask: true })).ok).toBe(true);
    expect(await ctx.store.beginToolCall(runId, { kind: "browser", requireTask: true })).toMatchObject({ ok: false, code: "ACTION_LIMIT" });
    // non-browser tools are not capped by the browser budget
    expect((await ctx.store.beginToolCall(runId, { kind: "tool", requireTask: true })).ok).toBe(true);
    const s = await ctx.store.getState(runId);
    expect(s.counters.browserActions).toBe(3);
    expect(s.tasks[0]!.browserActions).toBe(3);
  });
  it("stops browser tools after the time budget but keeps the reporter working", async () => {
    const { runId } = await newRun(ctx.store, { maxElapsedMs: 1000 });
    const t = await startTask(ctx.store, runId, "tester");
    await ctx.store.mutate(runId, (s) => {
      s.startedAt = new Date(Date.now() - 60_000).toISOString();
    });
    expect(await ctx.store.beginToolCall(runId, { kind: "browser", requireTask: true })).toMatchObject({ ok: false, code: "RUN_TIMEOUT" });
    await ctx.store.settleTask(runId, t, "budget_exhausted");
    await startTask(ctx.store, runId, "reporter");
    expect((await ctx.store.beginToolCall(runId, { kind: "tool", requireTask: true, allowedRoles: ["reporter"] })).ok).toBe(true);
  });
});

describe("checks, findings and the confirmation gate", () => {
  async function failedCheck() {
    const { runId } = await newRun(ctx.store);
    await startTask(ctx.store, runId, "tester");
    const act = await ctx.store.recordAction(runId, { kind: "action", taskId: "task-001", role: "tester", tool: "browser_click", summary: "click", ok: true });
    const r = await ctx.store.addCheck(runId, { title: "Rename persists", expected: "name kept", observed: "name reverted", status: "failed", evidenceIds: [act.id], suspectsProductDefect: true });
    if (!r.ok) throw new Error(r.code);
    return { runId, finding: r.finding!, evidence: act.id };
  }

  it("a failed check creates a suspected finding; a failed check without evidence is refused", async () => {
    const { finding } = await failedCheck();
    expect(finding.state).toBe("suspected");
    const { runId } = await newRun(ctx.store);
    await startTask(ctx.store, runId, "tester");
    expect(await ctx.store.addCheck(runId, { title: "t", expected: "e", observed: "o", status: "failed", evidenceIds: [] })).toMatchObject({ ok: false, code: "EVIDENCE_REQUIRED" });
  });
  it("without suspectsProductDefect a failure stays merely observed", async () => {
    const { runId } = await newRun(ctx.store);
    await startTask(ctx.store, runId, "tester");
    const a = await ctx.store.recordAction(runId, { kind: "action", taskId: "task-001", role: "tester", tool: "t", summary: "s", ok: true });
    const r = await ctx.store.addCheck(runId, { title: "t", expected: "e", observed: "o", status: "failed", evidenceIds: [a.id] });
    expect(r.ok && r.finding?.state).toBe("observed");
  });
  it("rejects invented evidence ids", async () => {
    const { runId } = await newRun(ctx.store);
    await startTask(ctx.store, runId, "tester");
    expect(await ctx.store.addCheck(runId, { title: "t", expected: "e", observed: "o", status: "passed", evidenceIds: ["action-999"] })).toMatchObject({ ok: false, code: "UNKNOWN_EVIDENCE" });
  });
  it("only a tester task can record checks", async () => {
    const { runId } = await newRun(ctx.store);
    await startTask(ctx.store, runId, "explorer");
    expect(await ctx.store.addCheck(runId, { title: "t", expected: "e", observed: "o", status: "passed", evidenceIds: [] })).toMatchObject({ ok: false, code: "ROLE_NOT_ALLOWED" });
  });

  it("the Tester's evidence alone can never confirm; the investigator must reproduce", async () => {
    const { runId, finding, evidence } = await failedCheck();
    await ctx.store.settleTask(runId, "task-001", "completed");
    await startTask(ctx.store, runId, "investigator", "investigate");
    const refused = await ctx.store.recordVerdict(runId, {
      findingId: finding.id,
      verdict: "confirmed",
      confidence: 0.9,
      severity: "high",
      reproductionSteps: ["a"],
      reproductionEvidenceIds: [evidence], // produced by the tester task
      rationale: "x",
    });
    expect(refused).toMatchObject({ ok: false, code: "INSUFFICIENT_EVIDENCE" });
    expect((await ctx.store.getFindings(runId))[0]!.state).toBe("suspected");

    const mine = await ctx.store.recordAction(runId, { kind: "action", taskId: "task-002", role: "investigator", tool: "browser_reload", summary: "reload", ok: true });
    const ok = await ctx.store.recordVerdict(runId, {
      findingId: finding.id,
      verdict: "confirmed",
      confidence: 0.9,
      severity: "high",
      reproductionSteps: ["Rename project", "Reload", "Name reverted"],
      reproductionEvidenceIds: [mine.id],
      rationale: "Reproduced",
    });
    expect(ok.ok).toBe(true);
    expect((await ctx.store.getFindings(runId))[0]).toMatchObject({ state: "confirmed", severity: "high" });
  });
  it("confirmation requires severity and steps; dismissal requires a reason; a failed action is not evidence", async () => {
    const { runId, finding } = await failedCheck();
    await ctx.store.settleTask(runId, "task-001", "completed");
    await startTask(ctx.store, runId, "investigator");
    const bad = await ctx.store.recordAction(runId, { kind: "action", taskId: "task-002", role: "investigator", tool: "browser_click", summary: "x", ok: false });
    expect(await ctx.store.recordVerdict(runId, { findingId: finding.id, verdict: "confirmed", confidence: 1, severity: "low", reproductionSteps: ["s"], reproductionEvidenceIds: [bad.id], rationale: "r" })).toMatchObject({ code: "INSUFFICIENT_EVIDENCE" });
    const good = await ctx.store.recordAction(runId, { kind: "action", taskId: "task-002", role: "investigator", tool: "browser_click", summary: "x", ok: true });
    expect(await ctx.store.recordVerdict(runId, { findingId: finding.id, verdict: "confirmed", confidence: 1, reproductionEvidenceIds: [good.id], rationale: "r" })).toMatchObject({ code: "INSUFFICIENT_EVIDENCE" });
    expect(await ctx.store.recordVerdict(runId, { findingId: finding.id, verdict: "dismissed", confidence: 0.8, rationale: "r" })).toMatchObject({ code: "DISMISS_REASON_REQUIRED" });
    const d = await ctx.store.recordVerdict(runId, { findingId: finding.id, verdict: "dismissed", confidence: 0.8, rationale: "expected", dismissReason: "expected_behavior" });
    expect(d.ok).toBe(true);
    expect((await ctx.store.getFindings(runId))[0]!.state).toBe("dismissed");
  });
  it("only the investigator records verdicts", async () => {
    const { runId, finding } = await failedCheck();
    expect(await ctx.store.recordVerdict(runId, { findingId: finding.id, verdict: "dismissed", confidence: 1, rationale: "r", dismissReason: "not_reproduced" })).toMatchObject({ code: "ROLE_NOT_ALLOWED" });
  });
  it("inconclusive keeps the finding suspected and flags it", async () => {
    const { runId, finding } = await failedCheck();
    await ctx.store.settleTask(runId, "task-001", "completed");
    await startTask(ctx.store, runId, "investigator");
    await ctx.store.recordVerdict(runId, { findingId: finding.id, verdict: "inconclusive", confidence: 0.3, rationale: "ran out of budget" });
    expect((await ctx.store.getFindings(runId))[0]).toMatchObject({ state: "suspected", inconclusive: true });
  });
});

describe("evidence ids and concurrency", () => {
  it("allocates unique sequential ids under concurrent writers", async () => {
    const { runId } = await newRun(ctx.store);
    await startTask(ctx.store, runId, "tester");
    const recs = await Promise.all(Array.from({ length: 25 }, (_, i) => ctx.store.recordAction(runId, { kind: "action", taskId: "task-001", role: "tester", tool: "t", summary: `s${i}`, ok: true })));
    expect(new Set(recs.map((r) => r.id)).size).toBe(25);
    expect((await ctx.store.listActions(runId)).length).toBe(25);
  });
  it("ignores a torn final line in the action log", async () => {
    const { runId } = await newRun(ctx.store);
    await ctx.store.recordAction(runId, { kind: "action", taskId: null, role: null, tool: "t", summary: "s", ok: true });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(`${ctx.store.runDir(runId)}/actions.jsonl`, '{"id":"action-0');
    expect((await ctx.store.listActions(runId)).length).toBe(1);
  });
});

describe("stale task recovery", () => {
  it("closes an abandoned active task that outlived the time budget so the run cannot deadlock", async () => {
    const { runId } = await newRun(ctx.store, { maxElapsedMs: 60_000 });
    await startTask(ctx.store, runId, "explorer");
    await ctx.store.mutate(runId, (s) => {
      s.tasks[0]!.startedAt = new Date(Date.now() - 120_000).toISOString();
    });
    expect((await ctx.store.reserveTask({ runId, role: "reporter", task: "report" })).ok).toBe(true);
    expect((await ctx.store.getState(runId)).tasks[0]!.status).toBe("failed");
  });
});
