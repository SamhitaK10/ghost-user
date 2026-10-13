import { defineTool } from "eve/tools";
import { z } from "zod";
import { clean } from "../../src/tools/runtime";
import { OrchestratorTools } from "../../src/tools/impl";

export default defineTool({
  description: "Create a test run for an authorized target. Refused if the URL's origin is not in the allowlist. Returns the runId.",
  inputSchema: z.object({
    url: z.string().max(500),
    objective: z.string().min(3).max(2000),
    constraints: z.string().max(1000).optional(),
  }),
  execute: async (a, ctx) => clean(await OrchestratorTools.startRun(a, ctx.session.id)),
});
