import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/core/store";

export async function tempStore(): Promise<{ store: RunStore; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ghost-user-test-"));
  return { store: new RunStore(dir), dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const ORIGIN = "http://127.0.0.1:4173";

export async function newRun(store: RunStore, budgets: Record<string, number> = {}) {
  return store.createRun({
    url: `${ORIGIN}/`,
    objective: "Test signup and project rename",
    allowedOrigins: [ORIGIN],
    budgets,
    env: {},
  });
}

/** Reserve a task for a role and return its id. */
export async function startTask(store: RunStore, runId: string, role: "explorer" | "tester" | "investigator" | "reporter", task = `${role} task`, taskKey?: string) {
  const r = await store.reserveTask({ runId, role, task, taskKey });
  if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
  return r.task.taskId;
}
