import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSubagentMessage, MAX_CONTEXT_CHARS } from "../src/core/context";
import { runDelegation } from "../src/tools/delegate";
import { getStore } from "../src/tools/runtime";
import { OrchestratorTools, RecordTools, ReporterTools } from "../src/tools/impl";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "http://127.0.0.1:4173";
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gu-deleg-"));
  for (const k of ["GHOST_USER_RUNS_DIR", "GHOST_USER_ALLOWED_ORIGINS", "GHOST_USER_SECRETS"]) saved[k] = process.env[k];
  process.env.GHOST_USER_RUNS_DIR = dir;
  process.env.GHOST_USER_ALLOWED_ORIGINS = ORIGIN;
  process.env.GHOST_USER_SECRETS = JSON.stringify({ demo_password: "super-secret-pw-123" });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  await rm(dir, { recursive: true, force: true });
});

const handoff = (over: Record<string, unknown> = {}) => ({
  status: "completed",
  summary: "done",
  evidenceIds: [],
  suspectedFailures: 0,
  nextAction: "test",
  ...over,
});
const tester = (over = {}) => handoff({ checksPassed: 0, checksFailed: 0, checksBlocked: 0, checkIds: [], ...over });

async function start() {
  const r = await OrchestratorTools.startRun({ url: `${ORIGIN}/`, objective: "check signup" });
  if (!r.ok) throw new Error(r.reason);
  return r.runId;
}

describe("start_run", () => {
  it("refuses an unauthorised URL and never exposes secret values", async () => {
    expect(await OrchestratorTools.startRun({ url: "http://evil.test/", objective: "x" })).toMatchObject({ ok: false, code: "UNAUTHORIZED_ORIGIN" });
    const r = await OrchestratorTools.startRun({ url: `${ORIGIN}/`, objective: "x" });
    expect(r).toMatchObject({ ok: true, secretNames: ["demo_password"] });
    expect(JSON.stringify(r)).not.toContain("super-secret-pw-123");
    const state = JSON.stringify(await getStore().getState((r as { runId: string }).runId));
    expect(state).not.toContain("super-secret-pw-123");
  });
});

describe("orchestrator routing rules", () => {
  it("requires a plan before tester or investigator", async () => {
    const runId = await start();
    const fake = async () => ({ status: "waiting", data: tester() });
    expect(await runDelegation({ runId, role: "tester", task: "t" }, fake)).toMatchObject({ ok: false, code: "PLAN_REQUIRED" });
  });
  it("does not start an investigator when there is nothing to investigate", async () => {
    const runId = await start();
    await OrchestratorTools.savePlan({ runId, steps: [{ id: "step-1", title: "a", expectedOutcome: "b" }] });
    const fake = async () => ({ status: "waiting", data: handoff() });
    expect(await runDelegation({ runId, role: "investigator", task: "i" }, fake)).toMatchObject({ ok: false, code: "NOTHING_TO_INVESTIGATE" });
  });
  it("delegates the explorer, stores its navigation map and returns a compact result", async () => {
    const runId = await start();
    const nav = { pages: [{ url: `${ORIGIN}/`, title: "Home", purpose: "landing" }], actionableElements: [], proposedPaths: [] };
    const res = await runDelegation({ runId, role: "explorer", task: "map" }, async () => ({ status: "waiting", data: handoff({ navigationMap: nav, evidenceIds: ["action-001"] }) }));
    expect(res).toMatchObject({ ok: true, role: "explorer", taskStatus: "completed", nextAction: "test" });
    expect(await getStore().getNavigationMap(runId)).toEqual(nav);
    expect(JSON.stringify(res).length).toBeLessThan(1500);
  });
  it("treats an invalid structured handoff as a failed task and records it", async () => {
    const runId = await start();
    const res = await runDelegation({ runId, role: "explorer", task: "map" }, async () => ({ status: "waiting", data: { oops: true } }));
    expect(res).toMatchObject({ ok: false, taskStatus: "failed" });
    expect((res as { error: string }).error).toContain("INVALID_HANDOFF");
    expect((await getStore().getState(runId)).activeTaskId).toBeNull();
  });
  it("turns an agent crash into a failed task, then enforces the retry limit", async () => {
    const runId = await start();
    const boom = async () => {
      throw new Error("model exploded");
    };
    const first = await runDelegation({ runId, role: "explorer", task: "map", taskKey: "x" }, boom);
    expect(first).toMatchObject({ ok: false, taskStatus: "failed" });
    const retry = await runDelegation({ runId, role: "explorer", task: "map", taskKey: "x" }, boom); // the single allowed retry
    expect(retry).toMatchObject({ ok: false, taskStatus: "failed" });
    expect(await runDelegation({ runId, role: "explorer", task: "map", taskKey: "x" }, boom)).toMatchObject({ ok: false, code: "RETRY_LIMIT" });
  });
  it("refuses to repeat completed work", async () => {
    const runId = await start();
    const ok = async () => ({ status: "waiting", data: handoff() });
    await runDelegation({ runId, role: "explorer", task: "map the site" }, ok);
    expect(await runDelegation({ runId, role: "explorer", task: "map the site" }, ok)).toMatchObject({ ok: false, code: "ALREADY_COMPLETED" });
  });
  it("reports store facts rather than the subagent's self-report", async () => {
    const runId = await start();
    await OrchestratorTools.savePlan({ runId, steps: [{ id: "step-1", title: "a", expectedOutcome: "b" }] });
    const res = await runDelegation({ runId, role: "tester", task: "run step 1" }, async () => ({
      status: "waiting",
      data: tester({ checksPassed: 9, checksFailed: 0, summary: "everything passed" }), // lies: nothing was recorded
    }));
    expect(res).toMatchObject({ ok: true, recorded: { checks: 0, failedChecks: 0, confirmed: 0 } });
  });
});

describe("whole pipeline with scripted agents (no browser, no model)", () => {
  it("tester -> investigator -> reporter -> finish yields a report with the right states", async () => {
    const runId = await start();
    await OrchestratorTools.savePlan({ runId, steps: [{ id: "step-1", title: "rename", expectedOutcome: "persists" }] });
    const store = getStore();

    const scriptedTester = async () => {
      const act = await store.recordAction(runId, { kind: "action", taskId: "task-001", role: "tester", tool: "browser_click", summary: "rename", ok: true });
      const c = await RecordTools.recordCheck({ runId, title: "Rename persists", expected: "kept", observed: "reverted", status: "failed", evidenceIds: [act.id], suspectsProductDefect: true });
      expect(c.ok).toBe(true);
      return { status: "waiting", data: tester({ checksFailed: 1, suspectedFailures: 1, nextAction: "investigate" }) };
    };
    expect(await runDelegation({ runId, role: "tester", task: "run step-1" }, scriptedTester)).toMatchObject({ ok: true, recorded: { suspected: 1, open: 1 } });

    const scriptedInvestigator = async () => {
      const act = await store.recordAction(runId, { kind: "action", taskId: "task-002", role: "investigator", tool: "browser_reload", summary: "reload", ok: true });
      const v = await RecordTools.recordVerdict({ runId, findingId: "finding-001", verdict: "confirmed", confidence: 0.9, severity: "high", reproductionSteps: ["rename", "reload"], reproductionEvidenceIds: [act.id], rationale: "reproduced" });
      expect(v).toMatchObject({ ok: true, state: "confirmed" });
      return { status: "waiting", data: handoff({ confirmed: 1, dismissed: 0, inconclusive: 0, nextAction: "report" }) };
    };
    expect(await runDelegation({ runId, role: "investigator", task: "investigate finding-001" }, scriptedInvestigator)).toMatchObject({ ok: true, recorded: { confirmed: 1, open: 0 } });

    const scriptedReporter = async () => {
      const w = await ReporterTools.write({ runId, executiveSummary: "One confirmed defect.", groups: [{ title: "Persistence", findingIds: ["finding-001", "finding-999"] }] });
      expect(w.ok).toBe(true);
      return { status: "waiting", data: handoff({ executiveSummary: "One confirmed defect.", groups: [], nextAction: "stop" }) };
    };
    expect(await runDelegation({ runId, role: "reporter", task: "report" }, scriptedReporter)).toMatchObject({ ok: true });

    const fin = await OrchestratorTools.finish({ runId, outcome: "objective_satisfied" });
    expect(fin).toMatchObject({ ok: true, result: "failed", counts: { confirmed: 1, checksFailed: 1 } });
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(`${dir}/${runId}/report.json`, "utf8"));
    expect(json.executiveSummary).toBe("One confirmed defect."); // reporter narrative survives finish_run
    expect(json.groups[0].findingIds).toEqual(["finding-001"]); // invented id dropped
    expect(json.findings[0]).toMatchObject({ state: "confirmed", severity: "high" });
    expect(json.metrics.model).toBeNull(); // no usage was recorded: nothing fabricated
  });

  it("role tools refuse the wrong role in code (tester cannot record a verdict or write the report)", async () => {
    const runId = await start();
    await OrchestratorTools.savePlan({ runId, steps: [{ id: "step-1", title: "a", expectedOutcome: "b" }] });
    await runDelegation({ runId, role: "tester", task: "t" }, async () => {
      expect(await RecordTools.recordVerdict({ runId, findingId: "finding-001", verdict: "dismissed", confidence: 1, rationale: "r", dismissReason: "not_reproduced" })).toMatchObject({ ok: false, code: "ROLE_NOT_ALLOWED" });
      expect(await ReporterTools.write({ runId })).toMatchObject({ ok: false, code: "ROLE_NOT_ALLOWED" });
      return { status: "waiting", data: tester() };
    });
  });
  it("tools refuse to run outside a delegated task", async () => {
    const runId = await start();
    expect(await RecordTools.recordCheck({ runId, title: "t", expected: "e", observed: "o", status: "passed", evidenceIds: [] })).toMatchObject({ ok: false, code: "NO_ACTIVE_TASK" });
  });
});

describe("bounded context", () => {
  it("never exceeds the hard cap, even with hostile inputs, and carries no secrets or raw content", async () => {
    const runId = await start();
    const store = getStore();
    const state = await store.getState(runId);
    const huge = "x".repeat(50_000);
    const msg = buildSubagentMessage({
      state: { ...state, objective: huge, constraints: huge },
      role: "tester",
      task: huge,
      taskId: "task-003",
      attempt: 1,
      plan: { steps: Array.from({ length: 20 }, (_, i) => ({ id: `step-${i + 1}`, title: huge, expectedOutcome: huge })) },
      navMap: { pages: Array.from({ length: 12 }, () => ({ url: huge, title: huge, purpose: huge })), proposedPaths: [] },
      checks: [],
      findings: [],
      evidence: [],
      evidenceIds: [],
      secretNames: ["demo_password"],
    });
    expect(msg.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(msg).toContain("demo_password");
    expect(msg).not.toContain("super-secret-pw-123");
  });
  it("gives each role only its slice of state", async () => {
    const runId = await start();
    await OrchestratorTools.savePlan({ runId, steps: [{ id: "step-1", title: "PLANSTEP", expectedOutcome: "b" }] });
    const seen: Record<string, string> = {};
    const capture = (role: string) => async (_r: string, message: string) => {
      seen[role] = message;
      return { status: "waiting", data: role === "tester" ? tester() : handoff() };
    };
    await runDelegation({ runId, role: "explorer", task: "map" }, capture("explorer") as never);
    await runDelegation({ runId, role: "tester", task: "test" }, capture("tester") as never);
    expect(seen.explorer).not.toContain("PLANSTEP");
    expect(seen.tester).toContain("PLANSTEP");
    expect(seen.tester).toContain("demo_password"); // the tester receives secret NAMES...
    expect(seen.tester).not.toContain("super-secret-pw-123"); // ...never values
    expect(seen.explorer).not.toContain("demo_password"); // the explorer does not need credentials at all
  });
});
