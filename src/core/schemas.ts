import { z } from "zod";
import { BudgetsSchema, ModelLimitsSchema } from "./config";

export const ROLES = ["explorer", "tester", "investigator", "reporter"] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

/* ---------- ids ---------- */
export const RunIdSchema = z.string().regex(/^run-[a-z0-9]{8,24}$/, "Invalid runId");
export const EvidenceIdSchema = z.string().regex(/^(action|screenshot|artifact|check)-\d{3,6}$/);
export const FindingIdSchema = z.string().regex(/^finding-\d{3,6}$/);
export const CheckIdSchema = z.string().regex(/^check-\d{3,6}$/);

/* ---------- run state ---------- */
export const TaskStatusSchema = z.enum(["active", "completed", "failed", "blocked", "budget_exhausted"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskRecordSchema = z.object({
  taskId: z.string(),
  role: RoleSchema,
  task: z.string(),
  taskKey: z.string(),
  depth: z.number().int(),
  status: TaskStatusSchema,
  browserActions: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  summary: z.string().optional(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const RunOutcomeSchema = z.enum(["objective_satisfied", "blocked", "budget_exhausted", "failed"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const RunStateSchema = z.object({
  runId: RunIdSchema,
  url: z.string(),
  objective: z.string(),
  constraints: z.string().optional(),
  sessionId: z.string().optional(),
  allowedOrigins: z.array(z.string()),
  secretNames: z.array(z.string()),
  budgets: BudgetsSchema,
  modelLimits: ModelLimitsSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  outcome: RunOutcomeSchema.optional(),
  outcomeNote: z.string().optional(),
  counters: z.object({
    agentInvocations: z.number().int(),
    toolCalls: z.number().int(),
    browserActions: z.number().int(),
  }),
  seq: z.record(z.string(), z.number().int()),
  activeTaskId: z.string().nullable(),
  tasks: z.array(TaskRecordSchema),
  /** taskKey -> attempts so far and last terminal status (retry and de-duplication logic). */
  taskKeys: z.record(
    z.string(),
    z.object({ attempts: z.number().int(), lastStatus: TaskStatusSchema, lastSummary: z.string().optional() }),
  ),
});
export type RunState = z.infer<typeof RunStateSchema>;

/* ---------- plan ---------- */
export const PlanStepSchema = z.object({
  id: z.string().regex(/^step-\d{1,3}$/),
  title: z.string().min(1).max(160),
  expectedOutcome: z.string().min(1).max(240),
});
export const PlanSchema = z.object({
  steps: z.array(PlanStepSchema).min(1).max(20),
  createdAt: z.string().optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

/* ---------- checks and findings ---------- */
export const CheckStatusSchema = z.enum(["passed", "failed", "blocked"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckSchema = z.object({
  id: CheckIdSchema,
  taskId: z.string(),
  planStepId: z.string().optional(),
  title: z.string().max(160),
  expected: z.string().max(400),
  observed: z.string().max(600),
  status: CheckStatusSchema,
  evidenceIds: z.array(z.string()).max(12),
  findingId: FindingIdSchema.optional(),
  createdAt: z.string(),
});
export type Check = z.infer<typeof CheckSchema>;

/**
 * observed   - a check failed; no claim about cause yet
 * suspected  - the Tester believes it is a product defect
 * confirmed  - the Investigator reproduced it with evidence (gated in code)
 * dismissed  - not a product defect (test-environment issue / not reproducible / expected)
 */
export const FindingStateSchema = z.enum(["observed", "suspected", "confirmed", "dismissed"]);
export type FindingState = z.infer<typeof FindingStateSchema>;
export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;
export const DismissReasonSchema = z.enum(["test_environment", "not_reproduced", "expected_behavior"]);
export type DismissReason = z.infer<typeof DismissReasonSchema>;

export const FindingSchema = z.object({
  id: FindingIdSchema,
  checkId: CheckIdSchema,
  title: z.string().max(160),
  expected: z.string().max(400),
  observed: z.string().max(600),
  state: FindingStateSchema,
  evidenceIds: z.array(z.string()),
  severity: SeveritySchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  reproductionSteps: z.array(z.string().max(240)).max(15).optional(),
  reproductionEvidenceIds: z.array(z.string()).optional(),
  rationale: z.string().max(600).optional(),
  dismissReason: DismissReasonSchema.optional(),
  inconclusive: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

/* ---------- evidence / action log ---------- */
export const ActionRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["action", "screenshot", "tool"]),
  ts: z.string(),
  taskId: z.string().nullable(),
  role: RoleSchema.nullable(),
  tool: z.string(),
  input: z.unknown().optional(),
  summary: z.string(),
  ok: z.boolean(),
  url: z.string().optional(),
  durationMs: z.number().optional(),
  errorCode: z.string().optional(),
  artifactId: z.string().optional(),
  file: z.string().optional(),
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

/* ---------- handoffs: compact, bounded subagent results ---------- */
export const HandoffStatusSchema = z.enum(["completed", "failed", "blocked", "budget_exhausted"]);
export const NextActionSchema = z.enum(["test", "investigate", "report", "retry", "stop"]);

const baseHandoff = {
  status: HandoffStatusSchema,
  summary: z.string().min(1).max(600),
  evidenceIds: z.array(z.string()).max(20),
  suspectedFailures: z.number().int().min(0).max(50),
  nextAction: NextActionSchema,
};

export const ExplorerHandoffSchema = z.object({
  ...baseHandoff,
  navigationMap: z
    .object({
      pages: z
        .array(z.object({ url: z.string().max(200), title: z.string().max(80), purpose: z.string().max(120) }))
        .max(12),
      actionableElements: z
        .array(
          z.object({
            page: z.string().max(200),
            role: z.string().max(30),
            name: z.string().max(80),
            purpose: z.string().max(100),
          }),
        )
        .max(25),
      proposedPaths: z
        .array(z.object({ name: z.string().max(80), steps: z.array(z.string().max(140)).max(10) }))
        .max(6),
    })
    .optional(),
});

export const TesterHandoffSchema = z.object({
  ...baseHandoff,
  checksPassed: z.number().int().min(0),
  checksFailed: z.number().int().min(0),
  checksBlocked: z.number().int().min(0),
  checkIds: z.array(z.string()).max(30),
});

export const InvestigatorHandoffSchema = z.object({
  ...baseHandoff,
  confirmed: z.number().int().min(0),
  dismissed: z.number().int().min(0),
  inconclusive: z.number().int().min(0),
});

export const ReporterHandoffSchema = z.object({
  ...baseHandoff,
  executiveSummary: z.string().min(1).max(1200),
  groups: z
    .array(z.object({ title: z.string().max(120), findingIds: z.array(FindingIdSchema).max(20) }))
    .max(12),
});

export const HANDOFF_SCHEMAS = {
  explorer: ExplorerHandoffSchema,
  tester: TesterHandoffSchema,
  investigator: InvestigatorHandoffSchema,
  reporter: ReporterHandoffSchema,
} as const;

export type Handoff = {
  status: z.infer<typeof HandoffStatusSchema>;
  summary: string;
  evidenceIds: string[];
  suspectedFailures: number;
  nextAction: z.infer<typeof NextActionSchema>;
  [key: string]: unknown;
};

/* ---------- report ---------- */
export const QAReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  generatedAt: z.string(),
  target: z.object({ url: z.string(), objective: z.string() }),
  outcome: z.object({
    result: z.enum(["passed", "failed", "blocked", "incomplete"]),
    runOutcome: RunOutcomeSchema.optional(),
    note: z.string().optional(),
  }),
  executiveSummary: z.string(),
  counts: z.object({
    checksPassed: z.number(),
    checksFailed: z.number(),
    checksBlocked: z.number(),
    confirmed: z.number(),
    suspected: z.number(),
    observed: z.number(),
    dismissed: z.number(),
  }),
  metrics: z.object({
    agentInvocations: z.number(),
    toolCalls: z.number(),
    browserActions: z.number(),
    runtimeMs: z.number(),
    model: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        totalTokens: z.number().optional(),
        costUsd: z.number().optional(),
      })
      .nullable(),
  }),
  limits: z.object({ budgets: BudgetsSchema, model: ModelLimitsSchema }),
  groups: z.array(z.object({ title: z.string(), findingIds: z.array(z.string()) })),
  findings: z.array(FindingSchema),
  checks: z.array(CheckSchema),
  evidence: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      tool: z.string(),
      summary: z.string(),
      url: z.string().optional(),
      file: z.string().optional(),
    }),
  ),
});
export type QAReport = z.infer<typeof QAReportSchema>;
