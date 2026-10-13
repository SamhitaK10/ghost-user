import { defineEval } from "eve/evals";
import { equals, includes, matches } from "eve/evals/expect";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type config from "./evals.config";

/**
 * Wiring check with deterministic scripted models (GHOST_USER_MOCK=1). Verifies that eve's runtime
 * runs the orchestrator, delegates through the `delegate` workflow tool to declared subagents with
 * structured handoffs, scopes their tools, persists state and writes the report.
 * It says nothing about how well a real model explores or tests.
 */
export default defineEval<typeof config>({
  description: "Mock-model smoke run: orchestrator -> explorer -> tester -> reporter -> finish_run.",
  tags: ["mock"],
  timeoutMs: 120_000,
  async test(t) {
    if (process.env.GHOST_USER_MOCK !== "1") t.skip("Requires GHOST_USER_MOCK=1 (scripted models).");
    const url = t.context.clean.url;
    const turn = await t.send(`Test ${url}/ and check that the home page renders.`);
    t.succeeded();
    t.toolOrder(["start_run", "delegate", "save_plan", "delegate", "delegate", "finish_run"]);
    t.calledTool("delegate", { count: 3 });
    t.notCalledTool("agent");
    t.noFailedActions();
    t.messageIncludes("finished");

    const runId = /run-[0-9a-f]{12}/.exec(turn.message ?? "")?.[0];
    await t.require(runId, matches(z.string().min(1)));
    const report = JSON.parse(await readFile(`${t.context.runsDir}/${runId}/report.json`, "utf8"));
    t.log(`report outcome=${report.outcome.result} counts=${JSON.stringify(report.counts)}`);
    t.check(report.counts, equals({ checksPassed: 1, checksFailed: 0, checksBlocked: 0, confirmed: 0, suspected: 0, observed: 0, dismissed: 0 }));
    t.check(report.outcome.result, equals("passed"));
    t.check(report.executiveSummary, includes("home page rendered"));
    t.check(report.metrics.agentInvocations, equals(3));
    // Structured handoffs must have validated: a task whose reply failed the schema is recorded as failed.
    const state = JSON.parse(await readFile(`${t.context.runsDir}/${runId}/state.json`, "utf8"));
    t.check(state.tasks.map((k: { role: string; status: string }) => `${k.role}:${k.status}`), equals(["explorer:completed", "tester:completed", "reporter:completed"]));
    t.check(state.activeTaskId, equals(null));
  },
});
