import { defineTool } from "eve/tools";
import { z } from "zod";
import { clean } from "../../src/tools/runtime";
import { OrchestratorTools } from "../../src/tools/impl";
import { RunIdSchema } from "../../src/core/schemas";

export default defineTool({
  description: "Save the test plan (3-8 steps). Required before delegating to the tester or investigator. Replaces any earlier plan.",
  inputSchema: z.object({
    runId: RunIdSchema,
    steps: z
      .array(z.object({ id: z.string().regex(/^step-\d{1,3}$/), title: z.string().max(160), expectedOutcome: z.string().max(240) }))
      .min(1)
      .max(12),
  }),
  execute: async (a) => clean(await OrchestratorTools.savePlan(a)),
});
