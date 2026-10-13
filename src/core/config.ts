import { z } from "zod";

/** Execution budgets. Every limit is enforced in code (store.ts), never only in prompts. */
export const BudgetsSchema = z.object({
  maxBrowserActionsPerTask: z.number().int().positive().default(30),
  maxTaskRetries: z.number().int().min(0).default(1),
  maxDelegationDepth: z.number().int().min(0).default(1),
  maxAgentInvocations: z.number().int().positive().default(14),
  maxElapsedMs: z.number().int().positive().default(10 * 60_000),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

/** Token/cost caps are enforced by eve's own `limits` (see agent/agent.ts); recorded here for the report. */
export const ModelLimitsSchema = z.object({
  maxInputTokensPerSession: z.number().int().positive().optional(),
  maxTokenCostUsdPerSession: z.number().positive().optional(),
});
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

type Env = Record<string, string | undefined>;

function num(env: Env, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
  return n;
}

export function loadBudgets(env: Env = process.env, overrides: Partial<Budgets> = {}): Budgets {
  const fromEnv: Partial<Budgets> = {};
  const map: [keyof Budgets, string][] = [
    ["maxBrowserActionsPerTask", "GHOST_USER_MAX_BROWSER_ACTIONS_PER_TASK"],
    ["maxTaskRetries", "GHOST_USER_MAX_TASK_RETRIES"],
    ["maxDelegationDepth", "GHOST_USER_MAX_DELEGATION_DEPTH"],
    ["maxAgentInvocations", "GHOST_USER_MAX_AGENT_INVOCATIONS"],
    ["maxElapsedMs", "GHOST_USER_MAX_ELAPSED_MS"],
  ];
  for (const [field, key] of map) {
    const v = num(env, key);
    if (v !== undefined) fromEnv[field] = v;
  }
  return BudgetsSchema.parse({ ...fromEnv, ...overrides });
}

export function loadModelLimits(env: Env = process.env): ModelLimits {
  return ModelLimitsSchema.parse({
    maxInputTokensPerSession: num(env, "GHOST_USER_MAX_INPUT_TOKENS"),
    maxTokenCostUsdPerSession: num(env, "GHOST_USER_MAX_COST_USD"),
  });
}

export function runsDir(env: Env = process.env): string {
  return env.GHOST_USER_RUNS_DIR && env.GHOST_USER_RUNS_DIR.length > 0
    ? env.GHOST_USER_RUNS_DIR
    : "runs";
}

/** Gateway model id (or override). Mock models for evals are selected in agent/agent.ts. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
export function modelId(env: Env = process.env): string {
  return env.GHOST_USER_MODEL && env.GHOST_USER_MODEL.length > 0 ? env.GHOST_USER_MODEL : DEFAULT_MODEL;
}
