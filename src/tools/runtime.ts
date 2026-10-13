import { runsDir } from "../core/config";
import { loadSecrets } from "../core/redact";
import { RunStore, StoreError, type Refusal } from "../core/store";
import { getRunBrowser, type RunBrowser } from "../core/browser";
import type { Role } from "../core/schemas";
import { truncate } from "../core/safety";

/** One store per process, rooted at GHOST_USER_RUNS_DIR (default ./runs). */
const KEY = Symbol.for("ghost-user.store");
export function getStore(): RunStore {
  const g = globalThis as unknown as Record<symbol, RunStore | undefined>;
  const dir = runsDir();
  const existing = g[KEY];
  if (existing && existing.rootDir === dir) return existing;
  const fresh = new RunStore(dir);
  g[KEY] = fresh;
  return fresh;
}

export type Failure = { ok: false; code: string; reason: string };

export function failure(e: unknown): Failure {
  if (e instanceof StoreError) return { ok: false, code: e.code, reason: truncate(e.message, 300) };
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, code: "TOOL_ERROR", reason: truncate(msg.split("\n")[0] ?? msg, 300) };
}

export function refusal(r: Refusal): Failure {
  return { ok: false, code: r.code, reason: r.reason };
}

export interface Guard {
  taskId: string | null;
  role: Role | null;
}

/**
 * Every role-scoped tool runs through here: budget accounting, role check and active-task check
 * happen in code before any side effect.
 */
export async function guarded<T>(
  runId: string,
  opts: { kind: "browser" | "tool"; allowedRoles: readonly Role[]; requireTask?: boolean },
  fn: (g: Guard) => Promise<T>,
): Promise<T | Failure> {
  try {
    const store = getStore();
    const g = await store.beginToolCall(runId, {
      kind: opts.kind,
      requireTask: opts.requireTask ?? true,
      allowedRoles: opts.allowedRoles,
    });
    if (!g.ok) return refusal(g);
    return await fn({ taskId: g.taskId, role: g.role });
  } catch (e) {
    return failure(e);
  }
}

export async function browserFor(runId: string): Promise<RunBrowser> {
  const state = await getStore().getState(runId);
  return getRunBrowser(runId, state.allowedOrigins, loadSecrets());
}

/**
 * eve serialises tool results with a JSON walker that throws on `undefined` property values.
 * Every model-facing result passes through this to drop them (and to guarantee plain JSON).
 */
export function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}
