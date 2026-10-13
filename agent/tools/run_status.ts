import { defineTool } from "eve/tools";
import { z } from "zod";
import { clean } from "../../src/tools/runtime";
import { OrchestratorTools } from "../../src/tools/impl";
import { RunIdSchema } from "../../src/core/schemas";

export default defineTool({
  description: "Compact run status: counters, remaining budget, check and finding counts, recent task summaries.",
  inputSchema: z.object({ runId: RunIdSchema }),
  execute: async (a) => clean(await OrchestratorTools.status(a)),
});
