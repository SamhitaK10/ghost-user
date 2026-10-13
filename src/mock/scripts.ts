/**
 * Deterministic model scripts for `GHOST_USER_MOCK=1`. They replace the LLM so that evals can
 * exercise eve's real runtime wiring (workflow tool, declared subagents, structured handoffs,
 * role-scoped tools, persisted state, report) without a model credential.
 *
 * They prove the plumbing works. They do NOT measure how well a real model explores or tests.
 */
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const RUN_RE = /run-[0-9a-f]{12}/;
const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const find = (req: MockModelRequest, name: string) => req.toolResults.filter((r) => r.name === name);
const runIdOf = (req: MockModelRequest): string | undefined => {
  const hay = [...req.messages.map((m) => m.text), ...req.toolResults.map((r) => asText(r.output))].join("\n");
  return hay.match(RUN_RE)?.[0];
};
const evidenceIds = (req: MockModelRequest): string[] =>
  [...new Set(req.toolResults.flatMap((r) => asText(r.output).match(/(?:action|screenshot)-\d{3}/g) ?? []))];
/** eve collects structured output through its reserved reply tool. */
const reply = (input: unknown): MockModelResponse => ({ toolCalls: [{ name: "eve__reply", input }] });
const handoffBase = (summary: string, ids: string[]) => ({ status: "completed", summary, evidenceIds: ids.slice(0, 5), suspectedFailures: 0 });

export function orchestratorScript(req: MockModelRequest): MockModelResponse {
  const done = new Set(req.toolResults.map((r) => r.name));
  const delegations = find(req, "delegate").length;
  const url = (req.userMessages.join(" ").match(/https?:\/\/[^\s,]+/) ?? [])[0] ?? "";
  const runId = runIdOf(req);
  if (!runId) {
    return { toolCalls: [{ name: "start_run", input: { url, objective: "Smoke test: open the site and check the home page renders." } }] };
  }
  if (!done.has("save_plan") && delegations === 0) {
    return { toolCalls: [{ name: "delegate", input: { runId, role: "explorer", task: "Map the home page and its navigation." } }] };
  }
  if (delegations === 1 && !done.has("save_plan")) {
    return { toolCalls: [{ name: "save_plan", input: { runId, steps: [{ id: "step-1", title: "Home page renders", expectedOutcome: "Home page loads with a heading" }] } }] };
  }
  if (delegations === 1) return { toolCalls: [{ name: "delegate", input: { runId, role: "tester", task: "Run step-1: open the home page and verify it renders." } }] };
  if (delegations === 2) return { toolCalls: [{ name: "delegate", input: { runId, role: "reporter", task: "Write the report." } }] };
  if (!done.has("finish_run")) return { toolCalls: [{ name: "finish_run", input: { runId, outcome: "objective_satisfied" } }] };
  return { text: `Run ${runId} finished. Report written.` };
}

export function explorerScript(req: MockModelRequest): MockModelResponse {
  const runId = runIdOf(req) ?? "";
  const target = req.messages.map((m) => m.text).join("\n").match(/TARGET: (\S+)/)?.[1] ?? "";
  if (find(req, "browser_open").length === 0) return { toolCalls: [{ name: "browser_open", input: { runId, url: target } }] };
  if (find(req, "browser_snapshot").length === 0) return { toolCalls: [{ name: "browser_snapshot", input: { runId, scope: "nav" } }] };
  return reply({
      ...handoffBase("Mapped the home page.", evidenceIds(req)),
      nextAction: "test",
      navigationMap: { pages: [{ url: target, title: "Home", purpose: "landing page" }], actionableElements: [], proposedPaths: [] },
    });
}

export function testerScript(req: MockModelRequest): MockModelResponse {
  const runId = runIdOf(req) ?? "";
  const target = req.messages.map((m) => m.text).join("\n").match(/TARGET: (\S+)/)?.[1] ?? "";
  if (find(req, "browser_open").length === 0) return { toolCalls: [{ name: "browser_open", input: { runId, url: target } }] };
  if (find(req, "record_check").length === 0) {
    const ids = evidenceIds(req);
    return {
      toolCalls: [{ name: "record_check", input: { runId, planStepId: "step-1", title: "Home page renders", expected: "Home page loads", observed: "Home page loaded", status: "passed", evidenceIds: ids.slice(0, 2) } }],
    };
  }
  return reply({ ...handoffBase("Home page renders.", evidenceIds(req)), nextAction: "report", checksPassed: 1, checksFailed: 0, checksBlocked: 0, checkIds: ["check-001"] });
}

export function investigatorScript(_req: MockModelRequest): MockModelResponse {
  return reply({ ...handoffBase("Nothing to investigate.", []), nextAction: "report", confirmed: 0, dismissed: 0, inconclusive: 0 });
}

export function reporterScript(req: MockModelRequest): MockModelResponse {
  const runId = runIdOf(req) ?? "";
  if (find(req, "report_context").length === 0) return { toolCalls: [{ name: "report_context", input: { runId } }] };
  if (find(req, "write_report").length === 0) return { toolCalls: [{ name: "write_report", input: { runId, executiveSummary: "Smoke run: the home page rendered." } }] };
  return reply({ ...handoffBase("Report written.", []), nextAction: "stop", executiveSummary: "Smoke run: the home page rendered.", groups: [] });
}
