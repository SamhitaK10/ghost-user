import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllBrowsers } from "../src/core/browser";
import { startDemoServer, ALL_BUGS, NO_BUGS, type DemoServer } from "../fixtures/demo-site/server";
import { runDelegation } from "../src/tools/delegate";
import { OrchestratorTools, RecordTools, ReporterTools } from "../src/tools/impl";
import { getStore } from "../src/tools/runtime";
import expectedDefects from "../fixtures/demo-site/expected-defects.json";
import { Driver, record, scenarioContactInvalid, scenarioDeleteTrap, scenarioRename, scenarioSettingsNav, scenarioSignup } from "./scripted";
import type { Finding } from "../src/core/schemas";

let demo: DemoServer;
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gu-e2e-"));
  for (const k of ["GHOST_USER_RUNS_DIR", "GHOST_USER_ALLOWED_ORIGINS", "GHOST_USER_SECRETS"]) saved[k] = process.env[k];
  process.env.GHOST_USER_RUNS_DIR = dir;
  process.env.GHOST_USER_SECRETS = JSON.stringify({ demo_password: "demo-pass-123" });
});
afterEach(async () => {
  await closeAllBrowsers();
  await demo?.close();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  await rm(dir, { recursive: true, force: true });
});

const H = (over: Record<string, unknown> = {}) => ({ status: "completed", summary: "done", evidenceIds: [], suspectedFailures: 0, nextAction: "test", ...over });

/** Defects matched by keyword groups: every group must have at least one keyword in the finding text. */
function matches(f: Pick<Finding, "title" | "expected" | "observed">, d: (typeof expectedDefects.defects)[number]) {
  const text = `${f.title} ${f.expected} ${f.observed}`.toLowerCase();
  return d.matchAll.every((group) => group.some((k) => text.includes(k.toLowerCase())));
}

async function must<T extends { ok: boolean }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`delegation failed: ${JSON.stringify(r)}`);
  return r;
}

async function fullRun(bugs: typeof ALL_BUGS) {
  demo = await startDemoServer({ bugs });
  process.env.GHOST_USER_ALLOWED_ORIGINS = demo.url;
  const base = demo.url;
  const started = await OrchestratorTools.startRun({ url: `${base}/`, objective: "Verify signup, projects, navigation and contact work" });
  if (!started.ok) throw new Error(started.reason);
  const runId = started.runId;
  const store = getStore();
  await OrchestratorTools.savePlan({ runId, steps: [{ id: "step-1", title: "core flows", expectedOutcome: "all behave as a user expects" }] });

  await must(runDelegation({ runId, role: "explorer", task: "map the site" }, async () => {
    const d = new Driver(runId);
    await d.open(`${base}/`);
    await d.snap();
    return { status: "waiting", data: H({ evidenceIds: d.evidence.slice(0, 3), navigationMap: { pages: [{ url: `${base}/`, title: "Home", purpose: "landing" }], actionableElements: [], proposedPaths: [] } }) };
  }));

  const scenarios = [scenarioSignup, scenarioRename, scenarioSettingsNav, scenarioContactInvalid, scenarioDeleteTrap];
  for (const [i, scenario] of scenarios.entries()) {
    // The orchestrator delegates narrow tasks: one scenario per tester invocation.
    await must(runDelegation({ runId, role: "tester", task: `run ${scenario.name}`, taskKey: `tester-${i}` }, async () => {
      const r = await record(runId, await scenario(new Driver(runId), base));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return { status: "waiting", data: H({ checksPassed: 0, checksFailed: 0, checksBlocked: 0, checkIds: [], nextAction: "test" }) };
    }));
  }

  const open = (await store.getFindings(runId)).filter((f) => f.state === "suspected");
  for (const f of open) {
    // One investigator task per finding: narrow tasks, each with its own action budget.
    await must(runDelegation({ runId, role: "investigator", task: `investigate ${f.id}`, taskKey: `inv-${f.id}` }, async () => {
      // Independent reproduction with fresh data.
      const redo = f.title.includes("Signup") ? await scenarioSignup(new Driver(runId), base, "inv+" + Math.random().toString(36).slice(2, 7))
        : f.title.includes("Renaming") ? await scenarioRename(new Driver(runId), base)
        : f.title.includes("Settings") ? await scenarioSettingsNav(new Driver(runId), base)
        : await scenarioContactInvalid(new Driver(runId), base);
      const r = redo.passed
        ? await RecordTools.recordVerdict({ runId, findingId: f.id, verdict: "dismissed", confidence: 0.7, rationale: "Could not reproduce", dismissReason: "not_reproduced" })
        : await RecordTools.recordVerdict({ runId, findingId: f.id, verdict: "confirmed", confidence: 0.9, severity: "medium", reproductionSteps: [redo.expected, redo.observed], reproductionEvidenceIds: redo.evidence.filter(Boolean), rationale: "Reproduced independently" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return { status: "waiting", data: H({ confirmed: 0, dismissed: 0, inconclusive: 0, nextAction: "report" }) };
    }));
  }

  await must(runDelegation({ runId, role: "reporter", task: "write the report" }, async () => {
    const w = await ReporterTools.write({ runId, executiveSummary: "Automated scripted run." });
    expect(w.ok).toBe(true);
    return { status: "waiting", data: H({ executiveSummary: "Automated scripted run.", groups: [], nextAction: "stop" }) };
  }));
  const fin = await OrchestratorTools.finish({ runId, outcome: "objective_satisfied" });
  expect(fin.ok).toBe(true);
  const report = JSON.parse(await readFile(`${dir}/${runId}/report.json`, "utf8"));
  const html = await readFile(`${dir}/${runId}/report.html`, "utf8");
  return { runId, report, html, base };
}

describe("end to end against the demo site (scripted agents, real browser)", () => {
  it("bugs ON: all four seeded defects confirmed with evidence, no false positives, delete trap untouched", async () => {
    const { report, html, runId } = await fullRun(ALL_BUGS);
    const confirmed: Finding[] = report.findings.filter((f: Finding) => f.state === "confirmed");

    const detected = expectedDefects.defects.filter((d) => confirmed.some((f) => matches(f, d)));
    const missed = expectedDefects.defects.filter((d) => !detected.includes(d)).map((d) => d.id);
    const falsePositives = confirmed.filter((f) => !expectedDefects.defects.some((d) => matches(f, d))).map((f) => f.title);
    console.log(`[e2e bugs=on] detected=${detected.length}/4 missed=${JSON.stringify(missed)} falsePositives=${JSON.stringify(falsePositives)}`);

    expect(missed).toEqual([]);
    expect(falsePositives).toEqual([]);
    expect(report.counts).toMatchObject({ confirmed: 4, checksFailed: 4, checksBlocked: 1 });
    expect(report.outcome.result).toBe("failed");
    for (const f of confirmed) {
      expect(f.reproductionSteps?.length).toBeGreaterThan(0);
      expect(f.evidenceIds.length).toBeGreaterThan(0);
    }
    expect(report.evidence.some((e: { kind: string }) => e.kind === "screenshot")).toBe(true);
    expect(html).toContain("data:image/jpeg;base64,");
    // safety: the destructive control was refused by policy, and the server never saw it
    expect(demo.snapshot().deleteAttempts).toBe(0);
    expect(report.checks.find((c: { title: string }) => c.title.includes("Destructive"))?.observed).toContain("BLOCKED_BY_POLICY");
    // efficiency numbers come from counters, model usage is absent => null, never invented
    expect(report.metrics.agentInvocations).toBe(11); // explorer + 5 testers + 4 investigators + reporter
    expect(report.metrics.browserActions).toBeGreaterThan(20);
    expect(report.metrics.model).toBeNull();
    // credentials never persisted anywhere in the run directory
    const { execSync } = await import("node:child_process");
    expect(() => execSync(`grep -r "demo-pass-123" ${dir}/${runId}`, { stdio: "pipe" })).toThrow();
  });

  it("bugs OFF: zero failed checks and zero confirmed findings (false-positive control)", async () => {
    const { report } = await fullRun(NO_BUGS);
    console.log(`[e2e bugs=off] failed=${report.counts.checksFailed} confirmed=${report.counts.confirmed}`);
    expect(report.counts).toMatchObject({ checksFailed: 0, confirmed: 0, suspected: 0 });
    expect(report.counts.checksPassed).toBe(4);
    // The destructive-control check is intentionally blocked by policy, so the honest overall result is "blocked", not "passed".
    expect(report.counts.checksBlocked).toBe(1);
    expect(report.outcome.result).toBe("blocked");
    expect(demo.snapshot().deleteAttempts).toBe(0);
  });
});
