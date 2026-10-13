import type { RunStore } from "./store";
import type { ActionRecord, Check, Finding, Plan, Role, RunState } from "./schemas";
import { truncate } from "./safety";

/**
 * Builds the ONLY context a subagent receives: role, immediate task, the slice of shared state
 * relevant to that role, and one-line references to evidence. No orchestrator conversation, no
 * raw traces, no screenshots. The result is hard-capped in code.
 */
export const MAX_CONTEXT_CHARS = 6000;

export interface NavMapLike {
  pages?: { url: string; title: string; purpose: string }[];
  actionableElements?: { page: string; role: string; name: string; purpose: string }[];
  proposedPaths?: { name: string; steps: string[] }[];
}

export interface ContextInput {
  state: RunState;
  role: Role;
  task: string;
  taskId: string;
  attempt: number;
  plan: Plan | null;
  navMap: NavMapLike | null;
  checks: Check[];
  findings: Finding[];
  evidence: ActionRecord[];
  evidenceIds: string[];
  secretNames: string[];
}

function line(s: string, max = 160): string {
  return truncate(s.replace(/\s+/g, " ").trim(), max);
}

export function buildSubagentMessage(i: ContextInput): string {
  const { state, role } = i;
  const parts: string[] = [];
  const remainingActions = Math.max(0, state.budgets.maxBrowserActionsPerTask);

  parts.push(`ROLE: ${role}`);
  parts.push(`RUN: ${state.runId}  TASK: ${i.taskId}  ATTEMPT: ${i.attempt}`);
  parts.push(`TARGET: ${state.url}`);
  parts.push(`OBJECTIVE: ${line(state.objective, 500)}`);
  if (state.constraints) parts.push(`CONSTRAINTS: ${line(state.constraints, 300)}`);
  parts.push(`YOUR TASK: ${line(i.task, 700)}`);
  if (role !== "reporter") {
    parts.push(
      `BUDGET: at most ${remainingActions} browser actions in this task (enforced by the tools). If a tool returns ACTION_LIMIT or RUN_TIMEOUT, stop and return status "budget_exhausted".`,
    );
  }
  if ((role === "tester" || role === "investigator") && i.secretNames.length > 0) {
    parts.push(`SECRETS (reference by name in browser_fill.secretName; you never see values): ${i.secretNames.join(", ")}`);
  }

  if ((role === "tester" || role === "investigator" || role === "reporter") && i.plan) {
    parts.push("PLAN:");
    for (const s of i.plan.steps.slice(0, 12)) parts.push(`- ${s.id}: ${line(s.title, 100)} -> ${line(s.expectedOutcome, 100)}`);
  }

  if (role === "tester" && i.navMap) {
    parts.push("NAVIGATION MAP (from explorer):");
    for (const p of (i.navMap.pages ?? []).slice(0, 8)) parts.push(`- page ${line(p.url, 80)} "${line(p.title, 40)}": ${line(p.purpose, 80)}`);
    for (const p of (i.navMap.proposedPaths ?? []).slice(0, 4)) parts.push(`- path ${line(p.name, 50)}: ${p.steps.slice(0, 8).map((s) => line(s, 70)).join(" > ")}`);
  }

  if (role === "tester" && i.checks.length > 0) {
    parts.push("CHECKS SO FAR (do not repeat passed ones):");
    for (const c of i.checks.slice(-10)) parts.push(`- ${c.id} [${c.status}] ${line(c.title, 90)}`);
  }

  if (role === "investigator") {
    const open = i.findings.filter((f) => f.state === "suspected" || f.state === "observed");
    parts.push("FINDINGS TO INVESTIGATE:");
    for (const f of open.slice(0, 8)) {
      parts.push(`- ${f.id} [${f.state}] ${line(f.title, 90)} | expected: ${line(f.expected, 100)} | observed: ${line(f.observed, 120)} | evidence: ${f.evidenceIds.slice(0, 5).join(",")}`);
    }
  }

  if (i.evidenceIds.length > 0) {
    parts.push("EVIDENCE REFERENCES (ids only; use tools to inspect, content is not included):");
    const byId = new Map(i.evidence.map((e) => [e.id, e]));
    for (const id of i.evidenceIds.slice(0, 12)) {
      const e = byId.get(id);
      parts.push(`- ${id}${e ? `: ${e.tool} ${line(e.summary, 100)}` : " (unknown)"}`);
    }
  }

  parts.push(
    `OUTPUT: finish with the structured result only. Keep "summary" under 600 characters. Reference evidence by id; never paste page content, HTML or credentials.`,
  );

  const text = parts.join("\n");
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS - 40)}\n[context truncated to ${MAX_CONTEXT_CHARS} chars]`;
}

export async function assembleContext(
  store: RunStore,
  args: { runId: string; role: Role; task: string; taskId: string; attempt: number; evidenceIds: string[]; secretNames: string[] },
): Promise<string> {
  const state = await store.getState(args.runId);
  const [plan, navMap, checks, findings, evidence] = await Promise.all([
    store.getPlan(args.runId),
    store.getNavigationMap<NavMapLike>(args.runId),
    store.getChecks(args.runId),
    store.getFindings(args.runId),
    store.listActions(args.runId),
  ]);
  return buildSubagentMessage({ state, ...args, plan, navMap, checks, findings, evidence });
}
