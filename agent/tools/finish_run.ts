import { defineTool } from "eve/tools";
import { z } from "zod";
import { clean } from "../../src/tools/runtime";
import { OrchestratorTools } from "../../src/tools/impl";
import { RunIdSchema } from "../../src/core/schemas";

export default defineTool({
  description: "Finish the run, close its browser and guarantee a report exists. Call once, after the reporter.",
  inputSchema: z.object({
    runId: RunIdSchema,
    outcome: z.enum(["objective_satisfied", "blocked", "budget_exhausted", "failed"]),
    note: z.string().max(400).optional(),
  }),
  execute: async (a) => clean(await OrchestratorTools.finish(a)),
});
