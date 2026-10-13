import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { HANDOFF_SCHEMAS, RoleSchema, RunIdSchema, type Role } from "../../src/core/schemas";
import { prepareDelegation, settleDelegation, type AgentOutcome } from "../../src/tools/delegate";

export default defineWorkflowTool({
  description:
    "Delegate ONE bounded task to a specialist: explorer (map the site), tester (run workflow checks), investigator (reproduce and confirm suspected failures), reporter (write the report). Blocks until the specialist returns a compact structured result. Budgets, retries, de-duplication and ordering are enforced here.",
  inputSchema: z.object({
    runId: RunIdSchema,
    role: RoleSchema,
    task: z.string().min(3).max(600).describe("One or two sentences. No page content, no credentials."),
    taskKey: z.string().max(60).optional().describe("Optional stable key used to de-duplicate repeated tasks."),
    evidenceIds: z.array(z.string()).max(12).optional().describe("Evidence ids to point the specialist at."),
  }),
  label: { start: ({ role, task }) => `${role}: ${task.slice(0, 70)}` },
  async execute(input, ctx) {
    "use workflow";
    const prepared = await prepare(input);
    if (!prepared.ok) return prepared;
    const role = input.role as Role;
    let outcome: AgentOutcome;
    try {
      const session = ctx.agent(role);
      const response = await session.send(prepared.message, { outputSchema: HANDOFF_SCHEMAS[role], signal: ctx.abortSignal });
      const r = await response.result();
      outcome = { status: r.status, data: r.data, message: r.message, error: r.error };
    } catch (e) {
      outcome = { status: "failed", error: { message: e instanceof Error ? e.message : String(e) } };
    }
    return await settle({ runId: input.runId, taskId: prepared.taskId, role, outcome });
  },
});

async function prepare(input: { runId: string; role: Role; task: string; taskKey?: string; evidenceIds?: string[] }) {
  "use step";
  return prepareDelegation(input);
}

async function settle(a: { runId: string; taskId: string; role: Role; outcome: AgentOutcome }) {
  "use step";
  return settleDelegation(a);
}
