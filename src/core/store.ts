import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBudgets, loadModelLimits, type Budgets } from "./config";
import { checkTargetUrl, truncate } from "./safety";
import {
  CheckSchema,
  FindingSchema,
  PlanSchema,
  RunIdSchema,
  RunStateSchema,
  type ActionRecord,
  type Check,
  type CheckStatus,
  type DismissReason,
  type Finding,
  type Handoff,
  type Plan,
  type Role,
  type RunOutcome,
  type RunState,
  type Severity,
  type TaskRecord,
  type TaskStatus,
} from "./schemas";

export class StoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export type Refusal = { ok: false; code: string; reason: string; previous?: { summary?: string; status: TaskStatus } };

const pad = (n: number) => String(n).padStart(3, "0");
const now = () => new Date().toISOString();

export function defaultTaskKey(role: Role, task: string): string {
  const norm = task.toLowerCase().replace(/\s+/g, " ").trim();
  return `${role}:${createHash("sha1").update(norm).digest("hex").slice(0, 8)}`;
}

export interface CreateRunInput {
  url: string;
  objective: string;
  constraints?: string;
  sessionId?: string;
  allowedOrigins: readonly string[];
  secretNames?: string[];
  budgets?: Partial<Budgets>;
  env?: Record<string, string | undefined>;
}

/**
 * File-backed run store. One directory per run:
 *   state.json  plan.json  navmap.json  checks.json  findings.json  usage.json
 *   actions.jsonl  handoffs.jsonl  artifacts/  screenshots/  report.{html,json}
 *
 * All mutations of state.json go through a per-run async lock and atomic rename, so concurrent
 * tool calls in one process cannot interleave. Cross-process writers are out of scope (see docs).
 */
export class RunStore {
  private locks = new Map<string, Promise<unknown>>();

  constructor(public readonly rootDir: string) {}

  /* ---------- paths ---------- */
  runDir(runId: string): string {
    const parsed = RunIdSchema.safeParse(runId);
    if (!parsed.success) throw new StoreError("INVALID_RUN_ID", "Invalid runId.");
    return join(this.rootDir, runId);
  }
  private file(runId: string, name: string): string {
    return join(this.runDir(runId), name);
  }

  /* ---------- low-level ---------- */
  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, path);
  }

  private async readJsonl<T>(path: string): Promise<T[]> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: T[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // a torn final line must not poison the whole log
      }
    }
    return out;
  }

  /* ---------- run lifecycle ---------- */
  async createRun(input: CreateRunInput): Promise<RunState> {
    const policy = checkTargetUrl(input.url, input.allowedOrigins);
    if (!policy.ok) throw new StoreError(policy.code, policy.reason);
    if (input.objective.trim().length === 0) throw new StoreError("INVALID_INPUT", "objective is required.");
    const env = input.env ?? process.env;
    const runId = `run-${randomBytes(6).toString("hex")}`;
    const state: RunState = {
      runId,
      url: new URL(input.url).toString(),
      objective: truncate(input.objective.trim(), 2000),
      constraints: input.constraints ? truncate(input.constraints.trim(), 1000) : undefined,
      sessionId: input.sessionId,
      allowedOrigins: [...input.allowedOrigins],
      secretNames: input.secretNames ?? [],
      budgets: loadBudgets(env, input.budgets),
      modelLimits: loadModelLimits(env),
      startedAt: now(),
      counters: { agentInvocations: 0, toolCalls: 0, browserActions: 0 },
      seq: {},
      activeTaskId: null,
      tasks: [],
      taskKeys: {},
    };
    await mkdir(join(this.runDir(runId), "screenshots"), { recursive: true });
    await mkdir(join(this.runDir(runId), "artifacts"), { recursive: true });
    await this.writeJson(this.file(runId, "state.json"), state);
    return state;
  }

  async getState(runId: string): Promise<RunState> {
    const raw = await this.readJson<unknown>(this.file(runId, "state.json"));
    if (!raw) throw new StoreError("UNKNOWN_RUN", `No run with id ${runId}.`);
    return RunStateSchema.parse(raw);
  }

  /** Read-modify-write under the run lock. `fn` may mutate and return a value. */
  async mutate<T>(runId: string, fn: (s: RunState) => T | Promise<T>): Promise<T> {
    return this.withLock(runId, async () => {
      const state = await this.getState(runId);
      const result = await fn(state);
      await this.writeJson(this.file(runId, "state.json"), state);
      return result;
    });
  }

  private nextId(s: RunState, prefix: string): string {
    const n = (s.seq[prefix] ?? 0) + 1;
    s.seq[prefix] = n;
    return `${prefix}-${pad(n)}`;
  }

  isExpired(s: RunState, at = Date.now()): boolean {
    return at - Date.parse(s.startedAt) > s.budgets.maxElapsedMs;
  }

  async listRuns(): Promise<RunState[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const runs: RunState[] = [];
    for (const n of names) {
      if (!RunIdSchema.safeParse(n).success) continue;
      try {
        runs.push(await this.getState(n));
      } catch {
        // skip unreadable runs
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async attachSession(runId: string, sessionId: string): Promise<void> {
    await this.mutate(runId, (s) => {
      s.sessionId = sessionId;
    });
  }

  /* ---------- delegation: reservation, budgets, retries ---------- */
  async reserveTask(input: {
    runId: string;
    role: Role;
    task: string;
    taskKey?: string;
    depth?: number;
  }): Promise<({ ok: true } & { task: TaskRecord; attempt: number }) | Refusal> {
    return this.mutate(input.runId, (s): ({ ok: true; task: TaskRecord; attempt: number }) | Refusal => {
      const depth = input.depth ?? 1;
      const isReporter = input.role === "reporter";
      if (s.endedAt) return { ok: false, code: "RUN_FINISHED", reason: "The run has already finished." };

      if (s.activeTaskId) {
        const active = s.tasks.find((t) => t.taskId === s.activeTaskId);
        const stale = active !== undefined && Date.now() - Date.parse(active.startedAt) > s.budgets.maxElapsedMs;
        if (!stale) {
          return {
            ok: false,
            code: "TASK_IN_PROGRESS",
            reason: `Task ${s.activeTaskId} is still active. Delegate one bounded task at a time.`,
          };
        }
        this.closeTaskInPlace(s, s.activeTaskId, "failed", "Closed as stale before the next delegation.");
      }

      if (depth > s.budgets.maxDelegationDepth) {
        return {
          ok: false,
          code: "DEPTH_LIMIT",
          reason: `Delegation depth ${depth} exceeds maxDelegationDepth=${s.budgets.maxDelegationDepth}.`,
        };
      }

      const key = input.taskKey?.trim() ? input.taskKey.trim().slice(0, 60) : defaultTaskKey(input.role, input.task);
      const prior = s.taskKeys[key];
      if (prior?.lastStatus === "completed") {
        return {
          ok: false,
          code: "ALREADY_COMPLETED",
          reason: `Task "${key}" already completed. Reuse its result instead of repeating the work.`,
          previous: { status: "completed", summary: prior.lastSummary },
        };
      }
      if (prior && prior.attempts - 1 >= s.budgets.maxTaskRetries) {
        return {
          ok: false,
          code: "RETRY_LIMIT",
          reason: `Task "${key}" already used its ${s.budgets.maxTaskRetries} retr${s.budgets.maxTaskRetries === 1 ? "y" : "ies"}.`,
          previous: { status: prior.lastStatus, summary: prior.lastSummary },
        };
      }

      if (isReporter) {
        const reporterRuns = s.tasks.filter((t) => t.role === "reporter").length;
        if (reporterRuns >= 2) {
          return { ok: false, code: "INVOCATION_LIMIT", reason: "The reporter already ran twice." };
        }
        // The reporter is exempt from the time and invocation budgets so a run that ran out of
        // budget can still produce its report.
      } else {
        if (this.isExpired(s)) {
          return {
            ok: false,
            code: "RUN_TIMEOUT",
            reason: `maxElapsedMs=${s.budgets.maxElapsedMs} exceeded. Delegate the reporter and finish the run.`,
          };
        }
        const nonReporter = s.tasks.filter((t) => t.role !== "reporter").length;
        if (nonReporter >= s.budgets.maxAgentInvocations) {
          return {
            ok: false,
            code: "INVOCATION_LIMIT",
            reason: `maxAgentInvocations=${s.budgets.maxAgentInvocations} reached. Delegate the reporter and finish the run.`,
          };
        }
      }

      const task: TaskRecord = {
        taskId: this.nextId(s, "task"),
        role: input.role,
        task: truncate(input.task, 600),
        taskKey: key,
        depth,
        status: "active",
        browserActions: 0,
        startedAt: now(),
      };
      s.tasks.push(task);
      s.activeTaskId = task.taskId;
      s.counters.agentInvocations += 1;
      s.taskKeys[key] = { attempts: (prior?.attempts ?? 0) + 1, lastStatus: "active", lastSummary: prior?.lastSummary };
      return { ok: true, task: { ...task }, attempt: s.taskKeys[key]!.attempts };
    });
  }

  private closeTaskInPlace(s: RunState, taskId: string, status: TaskStatus, summary?: string): void {
    const t = s.tasks.find((x) => x.taskId === taskId);
    if (!t || t.status !== "active") return;
    t.status = status;
    t.endedAt = now();
    t.summary = summary ? truncate(summary, 300) : undefined;
    const k = s.taskKeys[t.taskKey];
    if (k) {
      k.lastStatus = status;
      k.lastSummary = t.summary;
    }
    if (s.activeTaskId === taskId) s.activeTaskId = null;
  }

  async settleTask(runId: string, taskId: string, status: TaskStatus, handoff?: Handoff): Promise<void> {
    await this.mutate(runId, (s) => this.closeTaskInPlace(s, taskId, status, handoff?.summary));
    if (handoff) {
      await this.appendLine(runId, "handoffs.jsonl", { ts: now(), taskId, status, handoff });
    }
  }

  async finishRun(runId: string, outcome: RunOutcome, note?: string): Promise<RunState> {
    return this.mutate(runId, (s) => {
      if (s.activeTaskId) this.closeTaskInPlace(s, s.activeTaskId, "failed", "Run finished while task was active.");
      if (!s.endedAt) {
        s.endedAt = now();
        s.outcome = outcome;
        s.outcomeNote = note ? truncate(note, 400) : undefined;
      }
      return { ...s };
    });
  }

  /* ---------- tool accounting and browser budgets ---------- */
  /**
   * Call before every tool that touches the browser or records evidence.
   * Enforces: run still open, not timed out, an active task exists, and (for browser actions)
   * the per-task action cap. Increments counters.
   */
  async beginToolCall(
    runId: string,
    opts: { kind: "browser" | "tool"; requireTask: boolean; allowedRoles?: readonly Role[] },
  ): Promise<{ ok: true; taskId: string | null; role: Role | null } | Refusal> {
    return this.mutate(runId, (s): { ok: true; taskId: string | null; role: Role | null } | Refusal => {
      if (s.endedAt) return { ok: false, code: "RUN_FINISHED", reason: "The run has finished." };
      const active = s.activeTaskId ? s.tasks.find((t) => t.taskId === s.activeTaskId) : undefined;
      if (opts.requireTask) {
        if (!active) {
          return { ok: false, code: "NO_ACTIVE_TASK", reason: "No delegated task is active. Tools only work inside a delegated task." };
        }
        if (opts.allowedRoles && !opts.allowedRoles.includes(active.role)) {
          return { ok: false, code: "ROLE_NOT_ALLOWED", reason: `The ${active.role} role may not use this tool.` };
        }
        if (active.role !== "reporter" && this.isExpired(s)) {
          return { ok: false, code: "RUN_TIMEOUT", reason: `maxElapsedMs=${s.budgets.maxElapsedMs} exceeded. Stop and return status budget_exhausted.` };
        }
        if (opts.kind === "browser" && active.browserActions >= s.budgets.maxBrowserActionsPerTask) {
          return {
            ok: false,
            code: "ACTION_LIMIT",
            reason: `maxBrowserActionsPerTask=${s.budgets.maxBrowserActionsPerTask} reached. Stop and return status budget_exhausted with what you have.`,
          };
        }
      }
      s.counters.toolCalls += 1;
      if (opts.kind === "browser") {
        s.counters.browserActions += 1;
        if (active) active.browserActions += 1;
      }
      return { ok: true, taskId: active?.taskId ?? null, role: active?.role ?? null };
    });
  }

  /* ---------- action log / evidence ---------- */
  private async appendLine(runId: string, name: string, value: unknown): Promise<void> {
    await this.withLock(runId, async () => {
      await appendFile(this.file(runId, name), `${JSON.stringify(value)}\n`);
    });
  }

  /** Allocate the next id for a kind without writing a record (used for screenshots). */
  async allocateId(runId: string, prefix: "action" | "screenshot" | "artifact"): Promise<string> {
    return this.mutate(runId, (s) => this.nextId(s, prefix));
  }

  async recordAction(
    runId: string,
    rec: Omit<ActionRecord, "id" | "ts"> & { id?: string },
  ): Promise<ActionRecord> {
    const id = rec.id ?? (await this.allocateId(runId, rec.kind === "screenshot" ? "screenshot" : "action"));
    const full: ActionRecord = { ...rec, id, ts: now() };
    await this.appendLine(runId, "actions.jsonl", full);
    return full;
  }

  async listActions(runId: string): Promise<ActionRecord[]> {
    return this.readJsonl<ActionRecord>(this.file(runId, "actions.jsonl"));
  }

  async evidenceIndex(runId: string): Promise<Map<string, ActionRecord>> {
    const map = new Map<string, ActionRecord>();
    for (const a of await this.listActions(runId)) map.set(a.id, a);
    return map;
  }

  async saveArtifact(runId: string, text: string): Promise<string> {
    const id = await this.allocateId(runId, "artifact");
    await writeFile(join(this.runDir(runId), "artifacts", `${id}.txt`), text);
    return id;
  }

  async readArtifact(runId: string, id: string, offset: number, limit: number): Promise<{ text: string; total: number }> {
    if (!/^artifact-\d{3,6}$/.test(id)) throw new StoreError("INVALID_ID", "Invalid artifact id.");
    let text: string;
    try {
      text = await readFile(join(this.runDir(runId), "artifacts", `${id}.txt`), "utf8");
    } catch {
      throw new StoreError("UNKNOWN_ARTIFACT", `No artifact ${id}.`);
    }
    return { text: text.slice(offset, offset + Math.min(limit, 4000)), total: text.length };
  }

  async saveScreenshot(runId: string, bytes: Buffer): Promise<{ id: string; file: string }> {
    const id = await this.allocateId(runId, "screenshot");
    const file = `screenshots/${id}.jpg`;
    await writeFile(join(this.runDir(runId), file), bytes);
    return { id, file };
  }

  /* ---------- plan / navigation map / usage ---------- */
  async savePlan(runId: string, plan: Plan): Promise<Plan> {
    const parsed = PlanSchema.parse({ ...plan, createdAt: now() });
    await this.withLock(runId, () => this.writeJson(this.file(runId, "plan.json"), parsed));
    return parsed;
  }
  async getPlan(runId: string): Promise<Plan | null> {
    return this.readJson<Plan>(this.file(runId, "plan.json"));
  }
  async saveNavigationMap(runId: string, map: unknown): Promise<void> {
    await this.withLock(runId, () => this.writeJson(this.file(runId, "navmap.json"), map));
  }
  async getNavigationMap<T = unknown>(runId: string): Promise<T | null> {
    return this.readJson<T>(this.file(runId, "navmap.json"));
  }
  async saveNarrative(runId: string, narrative: unknown): Promise<void> {
    await this.withLock(runId, () => this.writeJson(this.file(runId, "narrative.json"), narrative));
  }
  async getNarrative<T = unknown>(runId: string): Promise<T | null> {
    return this.readJson<T>(this.file(runId, "narrative.json"));
  }
  async saveUsage(runId: string, usage: Record<string, number | undefined>): Promise<void> {
    await this.withLock(runId, () => this.writeJson(this.file(runId, "usage.json"), usage));
  }
  async getUsage(runId: string): Promise<Record<string, number | undefined> | null> {
    return this.readJson(this.file(runId, "usage.json"));
  }
  async listHandoffs(runId: string): Promise<{ ts: string; taskId: string; status: string; handoff: Handoff }[]> {
    return this.readJsonl(this.file(runId, "handoffs.jsonl"));
  }

  /* ---------- checks and findings ---------- */
  async getChecks(runId: string): Promise<Check[]> {
    return (await this.readJson<Check[]>(this.file(runId, "checks.json"))) ?? [];
  }
  async getFindings(runId: string): Promise<Finding[]> {
    return (await this.readJson<Finding[]>(this.file(runId, "findings.json"))) ?? [];
  }

  private async missingEvidence(runId: string, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const known = await this.evidenceIndex(runId);
    const checks = new Set((await this.getChecks(runId)).map((c) => c.id));
    return ids.filter((id) => !known.has(id) && !checks.has(id));
  }

  /**
   * Record a Tester check. A failed check also creates a finding:
   *   suspectsProductDefect=true  -> "suspected", otherwise "observed".
   * Evidence ids must already exist: reports can only link to real evidence.
   */
  async addCheck(
    runId: string,
    input: {
      planStepId?: string;
      title: string;
      expected: string;
      observed: string;
      status: CheckStatus;
      evidenceIds: string[];
      suspectsProductDefect?: boolean;
    },
  ): Promise<{ ok: true; check: Check; finding?: Finding } | Refusal> {
    const missing = await this.missingEvidence(runId, input.evidenceIds);
    if (missing.length > 0) {
      return { ok: false, code: "UNKNOWN_EVIDENCE", reason: `Unknown evidence ids: ${missing.join(", ")}. Use ids returned by tools.` };
    }
    if (input.status === "failed" && input.evidenceIds.length === 0) {
      return { ok: false, code: "EVIDENCE_REQUIRED", reason: "A failed check needs at least one evidence id (action or screenshot)." };
    }
    const state = await this.getState(runId);
    const task = state.tasks.find((t) => t.taskId === state.activeTaskId);
    if (!task || task.role !== "tester") {
      return { ok: false, code: "ROLE_NOT_ALLOWED", reason: "Only the tester records checks, inside an active tester task." };
    }
    const checkId = await this.mutate(runId, (s) => this.nextId(s, "check"));
    const findingId = input.status === "failed" ? await this.mutate(runId, (s) => this.nextId(s, "finding")) : undefined;
    const ts = now();
    const check = CheckSchema.parse({
      id: checkId,
      taskId: task.taskId,
      planStepId: input.planStepId,
      title: truncate(input.title, 160),
      expected: truncate(input.expected, 400),
      observed: truncate(input.observed, 600),
      status: input.status,
      evidenceIds: input.evidenceIds.slice(0, 12),
      findingId,
      createdAt: ts,
    });
    let finding: Finding | undefined;
    await this.withLock(runId, async () => {
      const checks = await this.getChecks(runId);
      checks.push(check);
      await this.writeJson(this.file(runId, "checks.json"), checks);
      if (findingId) {
        finding = FindingSchema.parse({
          id: findingId,
          checkId,
          title: check.title,
          expected: check.expected,
          observed: check.observed,
          state: input.suspectsProductDefect ? "suspected" : "observed",
          evidenceIds: check.evidenceIds,
          createdAt: ts,
          updatedAt: ts,
        });
        const findings = await this.getFindings(runId);
        findings.push(finding);
        await this.writeJson(this.file(runId, "findings.json"), findings);
      }
    });
    return { ok: true, check, finding };
  }

  /** Tester escalates an already-observed failure to "suspected". */
  async markSuspected(runId: string, findingId: string): Promise<{ ok: true; finding: Finding } | Refusal> {
    return this.withLock(runId, async () => {
      const findings = await this.getFindings(runId);
      const f = findings.find((x) => x.id === findingId);
      if (!f) return { ok: false as const, code: "UNKNOWN_FINDING", reason: `No finding ${findingId}.` };
      if (f.state === "observed") {
        f.state = "suspected";
        f.updatedAt = now();
        await this.writeJson(this.file(runId, "findings.json"), findings);
      }
      return { ok: true as const, finding: f };
    });
  }

  /**
   * Investigator verdict. "confirmed" is gated in code:
   *  - the active task must be an investigator task,
   *  - >=1 reproduction evidence id must exist AND have been produced by a browser action or screenshot
   *    during THIS investigator task (the Tester's evidence alone never confirms a defect),
   *  - reproduction steps, severity and confidence are required.
   * Anything weaker is refused so the finding stays "suspected".
   */
  async recordVerdict(
    runId: string,
    input: {
      findingId: string;
      verdict: "confirmed" | "dismissed" | "inconclusive";
      confidence: number;
      severity?: Severity;
      reproductionSteps?: string[];
      reproductionEvidenceIds?: string[];
      rationale: string;
      dismissReason?: DismissReason;
    },
  ): Promise<{ ok: true; finding: Finding } | Refusal> {
    const state = await this.getState(runId);
    const task = state.tasks.find((t) => t.taskId === state.activeTaskId);
    if (!task || task.role !== "investigator") {
      return { ok: false, code: "ROLE_NOT_ALLOWED", reason: "Only the investigator records verdicts, inside an active investigator task." };
    }
    const evidence = await this.evidenceIndex(runId);
    const repro = input.reproductionEvidenceIds ?? [];
    const unknown = repro.filter((id) => !evidence.has(id));
    if (unknown.length > 0) {
      return { ok: false, code: "UNKNOWN_EVIDENCE", reason: `Unknown evidence ids: ${unknown.join(", ")}.` };
    }
    if (input.verdict === "confirmed") {
      const fresh = repro.filter((id) => {
        const rec = evidence.get(id);
        return rec && rec.taskId === task.taskId && (rec.kind === "action" || rec.kind === "screenshot") && rec.ok;
      });
      if (fresh.length === 0) {
        return {
          ok: false,
          code: "INSUFFICIENT_EVIDENCE",
          reason:
            "To confirm, reproduce the failure yourself in this task and cite at least one browser action or screenshot id you produced now. The finding stays suspected.",
        };
      }
      if (!input.severity || !(input.reproductionSteps && input.reproductionSteps.length > 0)) {
        return { ok: false, code: "INSUFFICIENT_EVIDENCE", reason: "Confirming requires severity and reproductionSteps." };
      }
    }
    if (input.verdict === "dismissed" && !input.dismissReason) {
      return { ok: false, code: "DISMISS_REASON_REQUIRED", reason: "Dismissing requires dismissReason." };
    }
    return this.withLock(runId, async () => {
      const findings = await this.getFindings(runId);
      const f = findings.find((x) => x.id === input.findingId);
      if (!f) return { ok: false as const, code: "UNKNOWN_FINDING", reason: `No finding ${input.findingId}.` };
      if (input.verdict === "confirmed") f.state = "confirmed";
      else if (input.verdict === "dismissed") f.state = "dismissed";
      else {
        f.state = f.state === "observed" ? "suspected" : f.state;
        f.inconclusive = true;
      }
      f.confidence = Math.min(1, Math.max(0, input.confidence));
      f.severity = input.severity ?? f.severity;
      f.reproductionSteps = input.reproductionSteps?.map((s) => truncate(s, 240));
      f.reproductionEvidenceIds = repro;
      f.rationale = truncate(input.rationale, 600);
      f.dismissReason = input.dismissReason;
      f.evidenceIds = [...new Set([...f.evidenceIds, ...repro])];
      f.updatedAt = now();
      await this.writeJson(this.file(runId, "findings.json"), findings);
      return { ok: true as const, finding: f };
    });
  }
}
