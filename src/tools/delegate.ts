import { assembleContext } from "../core/context";
import { HANDOFF_SCHEMAS, RoleSchema, type Handoff, type Role, type TaskStatus } from "../core/schemas";
import { truncate } from "../core/safety";
import { clean, failure, getStore, refusal, type Failure } from "./runtime";

export interface Prepared {
  ok: true;
  taskId: string;
  attempt: number;
  message: string;
}

/**
 * Step 1 of a delegation. All routing rules are enforced here, in code:
 * one active task, retry/dedupe/depth/invocation/time budgets (store.reserveTask), plus ordering
 * rules (a plan before testing, open findings before investigating).
 */
export async function prepareDelegation(a: {
  runId: string;
  role: Role;
  task: string;
  taskKey?: string;
  evidenceIds?: string[];
}): Promise<Prepared | (Failure & { previous?: unknown })> {
  try {
    RoleSchema.parse(a.role);
    const store = getStore();
    if (a.role === "tester" || a.role === "investigator") {
      if (!(await store.getPlan(a.runId))) {
        return { ok: false, code: "PLAN_REQUIRED", reason: "Save a test plan (save_plan) before delegating to the tester or investigator." };
      }
    }
    if (a.role === "investigator") {
      const open = (await store.getFindings(a.runId)).filter((f) => f.state === "suspected" || f.state === "observed");
      if (open.length === 0) {
        return { ok: false, code: "NOTHING_TO_INVESTIGATE", reason: "There are no observed or suspected findings to investigate." };
      }
    }
    const reserved = await store.reserveTask({ runId: a.runId, role: a.role, task: a.task, taskKey: a.taskKey });
    if (!reserved.ok) return { ...refusal(reserved), previous: reserved.previous };
    const state = await store.getState(a.runId);
    const message = await assembleContext(store, {
      runId: a.runId,
      role: a.role,
      task: a.task,
      taskId: reserved.task.taskId,
      attempt: reserved.attempt,
      evidenceIds: a.evidenceIds ?? [],
      secretNames: state.secretNames,
    });
    return clean({ ok: true as const, taskId: reserved.task.taskId, attempt: reserved.attempt, message });
  } catch (e) {
    return failure(e);
  }
}

export interface AgentOutcome {
  status?: string;
  data?: unknown;
  message?: string;
  error?: { message: string };
}

export interface DelegationResult {
  ok: boolean;
  taskId: string;
  role: Role;
  taskStatus: TaskStatus;
  summary: string;
  nextAction?: string;
  evidenceIds?: string[];
  recorded: { checks: number; failedChecks: number; open: number; suspected: number; confirmed: number; dismissed: number };
  error?: string;
  actionsUsed?: number;
}

/** Step 3: validate the structured handoff, persist it, close the task, return a compact result. */
export async function settleDelegation(a: { runId: string; taskId: string; role: Role; outcome: AgentOutcome }): Promise<DelegationResult | Failure> {
  try {
    const store = getStore();
    let handoff: Handoff | undefined;
    let taskStatus: TaskStatus = "failed";
    let error: string | undefined;

    if (a.outcome.status === "failed" || a.outcome.error) {
      error = truncate(a.outcome.error?.message ?? "The subagent turn failed.", 300);
    } else {
      const parsed = HANDOFF_SCHEMAS[a.role].safeParse(a.outcome.data);
      if (!parsed.success) {
        error = truncate(`INVALID_HANDOFF: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, 300);
      } else {
        handoff = parsed.data as Handoff;
        taskStatus = handoff.status;
        if (a.role === "explorer" && "navigationMap" in parsed.data && parsed.data.navigationMap) {
          await store.saveNavigationMap(a.runId, parsed.data.navigationMap);
        }
      }
    }
    const fallback: Handoff | undefined = handoff
      ? undefined
      : { status: "failed", summary: error ?? "failed", evidenceIds: [], suspectedFailures: 0, nextAction: "retry" };
    await store.settleTask(a.runId, a.taskId, taskStatus, handoff ?? fallback);

    const [state, checks, findings] = await Promise.all([store.getState(a.runId), store.getChecks(a.runId), store.getFindings(a.runId)]);
    const task = state.tasks.find((t) => t.taskId === a.taskId);
    const count = (s: string) => findings.filter((f) => f.state === s).length;
    return clean({
      ok: !error,
      taskId: a.taskId,
      role: a.role,
      taskStatus,
      summary: truncate(handoff?.summary ?? error ?? "", 600),
      nextAction: handoff?.nextAction,
      evidenceIds: handoff?.evidenceIds.slice(0, 10),
      // Facts come from the store, not from the subagent's self-report.
      recorded: {
        checks: checks.length,
        failedChecks: checks.filter((c) => c.status === "failed").length,
        open: count("observed") + count("suspected"),
        suspected: count("suspected"),
        confirmed: count("confirmed"),
        dismissed: count("dismissed"),
      },
      error,
      actionsUsed: task?.browserActions,
    });
  } catch (e) {
    return failure(e);
  }
}

/** Reference composition used by tests; the eve tool runs the same three phases as workflow steps. */
export async function runDelegation(
  a: { runId: string; role: Role; task: string; taskKey?: string; evidenceIds?: string[] },
  runAgent: (role: Role, message: string) => Promise<AgentOutcome>,
): Promise<DelegationResult | Failure | (Failure & { previous?: unknown })> {
  const prepared = await prepareDelegation(a);
  if (!prepared.ok) return prepared;
  let outcome: AgentOutcome;
  try {
    outcome = await runAgent(a.role, prepared.message);
  } catch (e) {
    outcome = { status: "failed", error: { message: e instanceof Error ? e.message : String(e) } };
  }
  return settleDelegation({ runId: a.runId, taskId: prepared.taskId, role: a.role, outcome });
}
