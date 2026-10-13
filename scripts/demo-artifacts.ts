/**
 * Generates the demo artifacts in docs/demo/ (UI screenshots + a sample report).
 *
 * HONESTY NOTE: this uses the SCRIPTED agents from test/scripted.ts, not an LLM. It drives the real
 * tools, real browser, real run store, real report generator and the real UI against the seeded-bug
 * demo site, so it shows what the product records and renders. It does not show model quality.
 *
 *   npm run demo:artifacts
 */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { closeAllBrowsers } from "../src/core/browser";
import { startDemoServer } from "../fixtures/demo-site/server";
import { runDelegation } from "../src/tools/delegate";
import { OrchestratorTools, RecordTools, ReporterTools } from "../src/tools/impl";
import { getStore } from "../src/tools/runtime";
import { Driver, record, scenarioContactInvalid, scenarioDeleteTrap, scenarioRename, scenarioSettingsNav, scenarioSignup } from "../test/scripted";

const OUT = join(process.cwd(), "docs", "demo");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = (o: Record<string, unknown> = {}) => ({ status: "completed", summary: "done", evidenceIds: [], suspectedFailures: 0, nextAction: "test", ...o });

const tmp = await mkdtemp(join(tmpdir(), "ghost-user-demo-"));
process.env.GHOST_USER_RUNS_DIR = tmp;
process.env.GHOST_USER_SECRETS = JSON.stringify({ demo_password: "demo-pass-123" });
const demo = await startDemoServer({ port: 4173 });
process.env.GHOST_USER_ALLOWED_ORIGINS = demo.url;
await mkdir(OUT, { recursive: true });

const ui = spawn(process.execPath, ["--import", "tsx", "ui/server.ts"], { env: { ...process.env, GHOST_USER_UI_PORT: "4200" }, stdio: "ignore" }); // direct node child: ui.kill() really stops it
await sleep(3500);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: "light" })).newPage();
try {
  await page.goto("http://127.0.0.1:4200/");
  await page.waitForSelector("#url");
  await page.fill("#url", demo.url);
  await page.fill("#obj", "Verify signup, project creation and renaming, main navigation and the contact form work as a user would expect.");
  await page.screenshot({ path: join(OUT, "01-start.png") });

  const base = demo.url;
  const started = await OrchestratorTools.startRun({ url: `${base}/`, objective: "Verify signup, project creation and renaming, main navigation and the contact form work as a user would expect." });
  if (!started.ok) throw new Error(started.reason);
  const runId = started.runId;
  const store = getStore();
  await OrchestratorTools.savePlan({ runId, steps: [{ id: "step-1", title: "Sign up, rename a project, use navigation and the contact form", expectedOutcome: "Each flow behaves as a user expects" }] });

  await runDelegation({ runId, role: "explorer", task: "Map the site." }, async () => {
    const d = new Driver(runId);
    await d.open(`${base}/`);
    await d.snap();
    return { status: "waiting", data: H({ evidenceIds: d.evidence.slice(0, 3) }) };
  });

  const scenarios = [scenarioSignup, scenarioRename, scenarioSettingsNav, scenarioContactInvalid, scenarioDeleteTrap];
  for (const [i, scenario] of scenarios.entries()) {
    await runDelegation({ runId, role: "tester", task: `Run workflow check ${i + 1}: ${scenario.name.replace("scenario", "")}`, taskKey: `tester-${i}` }, async () => {
      const outcome = await scenario(new Driver(runId), base);
      if (i === 1) {
        // Hold the task open briefly so the execution screen can be captured mid-run with live store data.
        await page.goto(`http://127.0.0.1:4200/#/run/${runId}`);
        await page.waitForSelector(".timeline li");
        await sleep(1200);
        await page.screenshot({ path: join(OUT, "02-execution.png") });
      }
      await record(runId, outcome);
      return { status: "waiting", data: H({ checksPassed: 0, checksFailed: 0, checksBlocked: 0, checkIds: [] }) };
    });
  }
  const open = (await store.getFindings(runId)).filter((f) => f.state === "suspected");
  for (const f of open) {
    await runDelegation({ runId, role: "investigator", task: `Reproduce ${f.id}`, taskKey: `inv-${f.id}` }, async () => {
      const redo = f.title.includes("Signup") ? await scenarioSignup(new Driver(runId), base, "inv+" + Math.random().toString(36).slice(2, 7))
        : f.title.includes("Renaming") ? await scenarioRename(new Driver(runId), base)
        : f.title.includes("Settings") ? await scenarioSettingsNav(new Driver(runId), base)
        : await scenarioContactInvalid(new Driver(runId), base);
      await (redo.passed
        ? RecordTools.recordVerdict({ runId, findingId: f.id, verdict: "dismissed", confidence: 0.7, rationale: "Could not reproduce", dismissReason: "not_reproduced" })
        : RecordTools.recordVerdict({ runId, findingId: f.id, verdict: "confirmed", confidence: 0.9, severity: f.title.includes("persists") ? "high" : "medium", reproductionSteps: [redo.expected, redo.observed], reproductionEvidenceIds: redo.evidence.filter(Boolean), rationale: "Reproduced independently with fresh test data." }));
      return { status: "waiting", data: H({ confirmed: 0, dismissed: 0, inconclusive: 0, nextAction: "report" }) };
    });
  }
  await runDelegation({ runId, role: "reporter", task: "Write the report." }, async () => {
    await ReporterTools.write({ runId, executiveSummary: "Scripted demonstration run (not an LLM run) against the seeded-defect demo site. Four defects were reproduced independently and confirmed with screenshots; the destructive control was refused by policy." });
    return { status: "waiting", data: H({ executiveSummary: "demo", groups: [], nextAction: "stop" }) };
  });
  await OrchestratorTools.finish({ runId, outcome: "objective_satisfied" });

  await page.goto(`http://127.0.0.1:4200/#/run/${runId}/results`);
  await page.waitForSelector(".finding");
  await sleep(500);
  await page.screenshot({ path: join(OUT, "03-results.png"), fullPage: true });
  await cp(join(tmp, runId, "report.html"), join(OUT, "sample-report.html"));
  await cp(join(tmp, runId, "report.json"), join(OUT, "sample-report.json"));
  console.log(`Artifacts written to ${OUT} (run ${runId})`);
} finally {
  await browser.close();
  ui.kill();
  await closeAllBrowsers();
  await demo.close();
  await rm(tmp, { recursive: true, force: true });
}
