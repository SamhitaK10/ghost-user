import { defineTool } from "eve/tools";
import { z } from "zod";
import { clean } from "./runtime";
import { BrowserTools, RecordTools, ReporterTools, runIdField } from "./impl";
import { CheckStatusSchema, DismissReasonSchema, SeveritySchema } from "../core/schemas";

/**
 * Model-facing tool definitions, shared by the subagents. Each subagent re-exports only the ones its
 * role needs from its own tools/ directory (declared subagents inherit nothing). The role check
 * is ALSO enforced in code (guarded(...allowedRoles)) so a mis-wired tool still cannot be misused.
 */
const ref = z.string().regex(/^e\d{1,3}$/).describe("Element ref from the latest browser_snapshot, e.g. e7.");

export const browserOpen = defineTool({
  description: "Open a URL in the run's isolated browser. Only the authorized target origin is allowed. Returns the final url, title and any visible alert text.",
  inputSchema: z.object({ runId: runIdField, url: z.string().max(500) }),
  label: { start: ({ url }) => `Open ${url}` },
  execute: async (a) => clean(await BrowserTools.open(a)),
});

export const browserReload = defineTool({
  description: "Reload the current page (use to check whether a change persisted).",
  inputSchema: z.object({ runId: runIdField }),
  label: { start: () => "Reload page" },
  execute: async (a) => clean(await BrowserTools.reload(a)),
});

export const browserSnapshot = defineTool({
  description:
    "List the interactive elements of the current page as compact accessible entries (role, name, ref), plus headings. Cheap and cached: call it after navigation or a state change, not before every action. Prefer scope 'forms' or 'nav' and 'contains' to narrow output.",
  inputSchema: z.object({
    runId: runIdField,
    scope: z.enum(["all", "forms", "nav"]).optional(),
    maxElements: z.number().int().min(5).max(120).optional(),
    contains: z.string().max(60).optional().describe("Only elements whose name contains this text."),
  }),
  label: { start: () => "Inspect page elements" },
  execute: async (a) => clean(await BrowserTools.snapshot(a)),
});

export const browserClick = defineTool({
  description: "Click an element by ref. Refused for destructive or transactional controls (delete, pay, purchase...) and for stale refs: re-snapshot if told so.",
  inputSchema: z.object({ runId: runIdField, ref }),
  label: { start: ({ ref: r }) => `Click ${r}` },
  execute: async (a) => clean(await BrowserTools.click(a)),
});

export const browserFill = defineTool({
  description:
    "Fill a text field, textarea or select by ref. For credentials pass secretName (a name listed in SECRETS in your task) instead of value; you never see secret values. Never type real personal or payment data.",
  inputSchema: z
    .object({ runId: runIdField, ref, value: z.string().max(2000).optional(), secretName: z.string().max(40).optional() })
    .refine((v) => (v.value === undefined) !== (v.secretName === undefined), "Provide exactly one of value or secretName."),
  label: { start: ({ ref: r }) => `Fill ${r}` },
  execute: async (a) => clean(await BrowserTools.fill(a)),
});

export const browserPress = defineTool({
  description: "Press Enter, Tab or Escape.",
  inputSchema: z.object({ runId: runIdField, key: z.enum(["Enter", "Tab", "Escape"]) }),
  label: { start: ({ key }) => `Press ${key}` },
  execute: async (a) => clean(await BrowserTools.press(a)),
});

export const browserReadText = defineTool({
  description: "Read visible text of the page or of one element (ref). Output is truncated to maxChars; the overflow is saved as an artifact id readable with read_artifact.",
  inputSchema: z.object({ runId: runIdField, ref: ref.optional(), maxChars: z.number().int().min(100).max(2000).optional() }),
  label: { start: () => "Read page text" },
  execute: async (a) => clean(await BrowserTools.readText(a)),
});

export const browserConsole = defineTool({
  description: "Read recent browser console errors/warnings (redacted, bounded). Pass `since` (nextIndex from a previous call) to read only new entries.",
  inputSchema: z.object({ runId: runIdField, since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(30).optional() }),
  label: { start: () => "Read console" },
  execute: async (a) => clean(await BrowserTools.log({ ...a, kind: "console" })),
});

export const browserNetwork = defineTool({
  description: "Read recent failed requests and HTTP >=400 responses (method, url, status). Use after a suspicious action such as a form submit.",
  inputSchema: z.object({ runId: runIdField, since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(30).optional() }),
  label: { start: () => "Read failed requests" },
  execute: async (a) => clean(await BrowserTools.log({ ...a, kind: "network" })),
});

export const browserScreenshot = defineTool({
  description: "Capture a screenshot as report evidence. Returns an evidence id; the image is not shown to you. Take one when a check fails or after reproducing a defect.",
  inputSchema: z.object({ runId: runIdField, label: z.string().max(80).optional() }),
  label: { start: () => "Capture screenshot" },
  execute: async (a) => clean(await BrowserTools.screenshot(a)),
});

export const readArtifact = defineTool({
  description: "Read a slice of a saved text artifact (offset/limit, max 4000 chars).",
  inputSchema: z.object({ runId: runIdField, artifactId: z.string().regex(/^artifact-\d{3,6}$/), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(4000).optional() }),
  execute: async (a) => clean(await RecordTools.readArtifact(a)),
});

export const recordCheck = defineTool({
  description:
    "Record the result of one check. passed = behaviour matched expectation; failed = it did not (needs evidence ids from your browser tools); blocked = you could not run it. Set suspectsProductDefect=true only when you believe the PRODUCT is wrong rather than your test approach. Returns a findingId for failed checks.",
  inputSchema: z.object({
    runId: runIdField,
    planStepId: z.string().regex(/^step-\d{1,3}$/).optional(),
    title: z.string().min(3).max(160),
    expected: z.string().min(3).max(400),
    observed: z.string().min(3).max(600),
    status: CheckStatusSchema,
    evidenceIds: z.array(z.string()).max(12),
    suspectsProductDefect: z.boolean().optional(),
  }),
  label: { start: ({ title }) => `Record check: ${title}` },
  execute: async (a) => clean(await RecordTools.recordCheck(a)),
});

export const markSuspected = defineTool({
  description: "Escalate an observed failing finding to 'suspected' product defect.",
  inputSchema: z.object({ runId: runIdField, findingId: z.string().regex(/^finding-\d{3,6}$/) }),
  execute: async (a) => clean(await RecordTools.markSuspected(a)),
});

export const getFinding = defineTool({
  description: "Read one finding with one-line summaries of its evidence (not raw content).",
  inputSchema: z.object({ runId: runIdField, findingId: z.string().regex(/^finding-\d{3,6}$/) }),
  execute: async (a) => clean(await RecordTools.getFinding(a)),
});

export const recordVerdict = defineTool({
  description:
    "Record your verdict on a finding. 'confirmed' is only accepted if you reproduced the failure yourself in THIS task and cite your own action/screenshot evidence ids, plus severity and reproductionSteps. 'dismissed' needs a dismissReason. Otherwise use 'inconclusive'.",
  inputSchema: z.object({
    runId: runIdField,
    findingId: z.string().regex(/^finding-\d{3,6}$/),
    verdict: z.enum(["confirmed", "dismissed", "inconclusive"]),
    confidence: z.number().min(0).max(1),
    severity: SeveritySchema.optional(),
    reproductionSteps: z.array(z.string().max(240)).max(15).optional(),
    reproductionEvidenceIds: z.array(z.string()).max(12).optional(),
    rationale: z.string().min(3).max(600),
    dismissReason: DismissReasonSchema.optional(),
  }),
  label: { start: ({ findingId, verdict }) => `Verdict ${findingId}: ${verdict}` },
  execute: async (a) => clean(await RecordTools.recordVerdict(a)),
});

export const reportContext = defineTool({
  description: "Compact summary of the run's stored facts: checks and findings with states. Use it to write the narrative.",
  inputSchema: z.object({ runId: runIdField }),
  execute: async (a) => clean(await ReporterTools.context(a)),
});

export const writeReportTool = defineTool({
  description:
    "Generate the HTML+JSON QA report from stored facts. You may add an executive summary and group findings by theme; unknown finding ids are ignored. You cannot change states, counts or evidence.",
  inputSchema: z.object({
    runId: runIdField,
    executiveSummary: z.string().max(1200).optional(),
    groups: z.array(z.object({ title: z.string().max(120), findingIds: z.array(z.string().regex(/^finding-\d{3,6}$/)).max(20) })).max(12).optional(),
  }),
  label: { start: () => "Write QA report" },
  execute: async (a) => clean(await ReporterTools.write(a)),
});
