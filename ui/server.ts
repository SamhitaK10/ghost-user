/**
 * Ghost User web UI: a thin local server. It reads run state from the same file-backed run store
 * the agent tools write to, and talks to the eve agent through the typed eve client. Nothing here is
 * simulated: every number and row shown comes from the store or from eve's event stream.
 *
 *   terminal 1:  npm run dev      (eve agent server, default http://127.0.0.1:2000)
 *   terminal 2:  npm run ui       (this server,      http://127.0.0.1:4200)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import { runsDir } from "../src/core/config";
import { loadSecrets, secretNames } from "../src/core/redact";
import { checkTargetUrl, parseAllowedOrigins, truncate } from "../src/core/safety";
import { RunIdSchema } from "../src/core/schemas";
import { writeReport, type Narrative } from "../src/core/report";
import { RunStore, StoreError } from "../src/core/store";
import { closeRunBrowser } from "../src/core/browser";
import { isAllowedRequest } from "./guard";

const PORT = Number(process.env.GHOST_USER_UI_PORT ?? 4200);
const HOST = "127.0.0.1"; // local only: the UI can start browser sessions, so it is never exposed on the network
const EVE_HOST = process.env.GHOST_USER_EVE_URL ?? "http://127.0.0.1:2000";
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const store = new RunStore(runsDir());
const client = new Client({ host: EVE_HOST });
const live = new Map<string, { cancel: () => Promise<unknown>; startedAt: number }>();

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}
const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v));

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 20_000) throw new StoreError("INVALID_INPUT", "Request too large.");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    throw new StoreError("INVALID_INPUT", "Body must be JSON.");
  }
}

function startMessage(runId: string, url: string, objective: string, constraints?: string): string {
  return [`RUN ${runId}`, `Target: ${url}`, `Objective: ${objective}`, constraints ? `Constraints: ${constraints}` : ""].filter(Boolean).join("\n");
}

async function finalise(runId: string, outcome: "objective_satisfied" | "blocked" | "budget_exhausted" | "failed", note: string) {
  const state = await store.getState(runId);
  if (!state.endedAt) {
    await store.finishRun(runId, outcome, note);
    const narrative = await store.getNarrative<Narrative>(runId);
    await writeReport(store, runId, narrative ?? undefined);
  }
  await closeRunBrowser(runId);
}

async function launch(runId: string, url: string, objective: string, constraints?: string) {
  const { response, session } = await client.sessions.create({ message: startMessage(runId, url, objective, constraints) });
  await store.attachSession(runId, session.state.sessionId);
  live.set(runId, { cancel: () => response.cancel(), startedAt: Date.now() });
  void (async () => {
    try {
      for await (const event of response) {
        const usage = (event as { data?: { usage?: Record<string, number | undefined> } }).data?.usage;
        if (usage && typeof usage === "object") await store.saveUsage(runId, usage);
        if (event.type === "input.requested") {
          // eve paused for a human decision (e.g. its token/cost limit prompt). An unattended QA run stops instead of continuing.
          await response.cancel().catch(() => undefined);
          await finalise(runId, "budget_exhausted", "The agent runtime paused for input (model usage limit). Run stopped.");
          return;
        }
        if (event.type === "session.failed" || event.type === "turn.failed") {
          const msg = (event as { data?: { message?: string } }).data?.message ?? "The agent session failed.";
          await finalise(runId, "failed", truncate(msg, 300));
          return;
        }
        if (event.type === "session.waiting" || event.type === "session.completed") break;
      }
      // Normal end: finish_run should already have closed the run; otherwise the agent stopped early.
      await finalise(runId, "failed", "The agent ended without calling finish_run. Report generated from stored facts.");
    } catch (e) {
      await finalise(runId, "failed", truncate(`Stream error: ${e instanceof Error ? e.message : String(e)}`, 300)).catch(() => undefined);
    } finally {
      live.delete(runId);
    }
  })();
}

async function runView(runId: string) {
  const [state, plan, checks, findings, actions, usage] = await Promise.all([
    store.getState(runId),
    store.getPlan(runId),
    store.getChecks(runId),
    store.getFindings(runId),
    store.listActions(runId),
    store.getUsage(runId),
  ]);
  const active = state.tasks.find((t) => t.taskId === state.activeTaskId) ?? null;
  const end = state.endedAt ? Date.parse(state.endedAt) : Date.now();
  let hasReport = false;
  try {
    await readFile(join(store.runDir(runId), "report.json"));
    hasReport = true;
  } catch {
    hasReport = false;
  }
  return {
    runId,
    url: state.url,
    objective: state.objective,
    finished: Boolean(state.endedAt),
    outcome: state.outcome ?? null,
    outcomeNote: state.outcomeNote ?? null,
    activeTask: active,
    tasks: state.tasks,
    plan: plan?.steps ?? [],
    checks,
    findings,
    timeline: actions.slice(-60),
    counters: state.counters,
    budgets: state.budgets,
    elapsedMs: end - Date.parse(state.startedAt),
    usage: usage ?? null,
    hasReport,
    secretNames: state.secretNames,
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === "/api/config" && req.method === "GET") {
    let agent = "unreachable";
    try {
      await client.health();
      agent = "ready";
    } catch {
      agent = "unreachable";
    }
    return json(res, 200, { agent, agentHost: EVE_HOST, allowedOrigins: parseAllowedOrigins(), secretNames: secretNames(loadSecrets()) });
  }
  if (path === "/api/runs" && req.method === "GET") {
    const runs = await store.listRuns();
    return json(res, 200, runs.slice(0, 30).map((s) => ({ runId: s.runId, url: s.url, objective: truncate(s.objective, 120), startedAt: s.startedAt, finished: Boolean(s.endedAt), outcome: s.outcome ?? null })));
  }
  if (path === "/api/runs" && req.method === "POST") {
    const body = await readJson(req);
    const url = String(body.url ?? "").trim();
    const objective = String(body.objective ?? "").trim();
    const constraints = body.constraints ? String(body.constraints).trim() : undefined;
    const allowed = parseAllowedOrigins();
    const policy = checkTargetUrl(url, allowed);
    if (!policy.ok) return json(res, 400, { error: policy.reason, code: policy.code });
    if (objective.length < 3) return json(res, 400, { error: "Describe what to test (objective).", code: "INVALID_INPUT" });
    try {
      await client.health();
    } catch {
      return json(res, 503, { error: `The eve agent is not reachable at ${EVE_HOST}. Start it with "npm run dev".`, code: "AGENT_UNREACHABLE" });
    }
    const state = await store.createRun({ url, objective, constraints, allowedOrigins: allowed, secretNames: secretNames(loadSecrets()) });
    try {
      await launch(state.runId, state.url, state.objective, state.constraints);
    } catch (e) {
      await finalise(state.runId, "failed", truncate(`Could not start the agent session: ${e instanceof Error ? e.message : String(e)}`, 300));
      return json(res, 502, { error: "Could not start the agent session.", code: "LAUNCH_FAILED" });
    }
    return json(res, 201, { runId: state.runId });
  }
  const m = path.match(/^\/api\/runs\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const runId = m[1]!;
    if (!RunIdSchema.safeParse(runId).success) return json(res, 400, { error: "Invalid run id." });
    const rest = m[2] ?? "";
    if (rest === "" && req.method === "GET") return json(res, 200, await runView(runId));
    if (rest === "cancel" && req.method === "POST") {
      await live.get(runId)?.cancel().catch(() => undefined);
      await finalise(runId, "failed", "Cancelled by user.");
      return json(res, 200, { ok: true });
    }
    if (rest === "report.json" || rest === "report.html") {
      const file = await readFile(join(store.runDir(runId), rest)).catch(() => null);
      if (!file) return json(res, 404, { error: "Report not generated yet." });
      const headers: Record<string, string> = rest.endsWith("html") ? { "content-disposition": `attachment; filename="ghost-user-${runId}.html"` } : { "content-disposition": `attachment; filename="ghost-user-${runId}.json"` };
      res.writeHead(200, { "content-type": MIME[extname(rest)]!, "cache-control": "no-store", ...headers });
      return res.end(file);
    }
    const shot = rest.match(/^screenshots\/(screenshot-\d{3,6})\.jpg$/);
    if (shot) {
      const file = await readFile(join(store.runDir(runId), "screenshots", `${shot[1]}.jpg`)).catch(() => null);
      return file ? send(res, 200, file, "image/jpeg") : json(res, 404, { error: "Not found." });
    }
  }
  return json(res, 404, { error: "Not found." });
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!isAllowedRequest({ host: req.headers.host, origin: req.headers.origin }, req.method ?? "GET", PORT)) return json(res, 403, { error: "Forbidden." });
    if (path.startsWith("/api/")) return await handleApi(req, res, path);
    const rel = path === "/" ? "/index.html" : path;
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain");
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, "Not found", "text/plain");
    return send(res, 200, body, MIME[extname(file)] ?? "application/octet-stream");
  } catch (e) {
    if (e instanceof StoreError) return json(res, e.code === "UNKNOWN_RUN" ? 404 : 400, { error: e.message, code: e.code });
    return json(res, 500, { error: "Internal error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ghost User UI: http://${HOST}:${PORT}  (agent: ${EVE_HOST}, runs: ${runsDir()})`);
  if (parseAllowedOrigins().length === 0) console.log("Warning: GHOST_USER_ALLOWED_ORIGINS is empty, so no target can be tested. See .env.example.");
});
