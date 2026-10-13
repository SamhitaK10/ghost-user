import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEvalConfig } from "eve/evals";
import { ALL_BUGS, NO_BUGS, startDemoServer } from "../fixtures/demo-site/server";

/**
 * Starts the demo site (a separate process-level fixture, never part of the agent) for evals.
 * Two instances: one clean, one with the seeded defects. Origins must be authorised up front, so
 * `npm run eval:*` pins the ports and sets GHOST_USER_ALLOWED_ORIGINS accordingly.
 */
export const CLEAN_PORT = Number(process.env.GHOST_USER_EVAL_CLEAN_PORT ?? 4181);
export const BUGGY_PORT = Number(process.env.GHOST_USER_EVAL_BUGGY_PORT ?? 4182);

export default defineEvalConfig({
  async setup() {
    process.env.GHOST_USER_RUNS_DIR ??= await mkdtemp(join(tmpdir(), "ghost-user-evals-"));
    const clean = await startDemoServer({ port: CLEAN_PORT, bugs: NO_BUGS });
    const buggy = await startDemoServer({ port: BUGGY_PORT, bugs: ALL_BUGS });
    return { clean, buggy, runsDir: process.env.GHOST_USER_RUNS_DIR };
  },
  async teardown(context) {
    await context?.clean.close();
    await context?.buggy.close();
  },
});
