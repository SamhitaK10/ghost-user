# Ghost User

Autonomous website QA built on [Vercel's eve](https://github.com/vercel/eve) agent framework (v0.78.0).
Give it a URL and an objective. An orchestrator delegates to four specialist subagents that explore the
site, run workflows in a real browser, independently reproduce suspected bugs, and write an
evidence-backed HTML + JSON report.

> **Status: working MVP, not yet validated with a live model.** Everything below was verified with
> the commands in [docs/TESTING.md](docs/TESTING.md). The one thing that could **not** be run in the
> development sandbox is a real-LLM session (no model credential was available). The agent quality
> evals are written (`evals/real-model.eval.ts`) but have **not** been run; no detection-rate
> numbers are claimed. See [Known limitations](#known-limitations).

![start](docs/demo/01-start.png)
![execution](docs/demo/02-execution.png)

Screens are from [`npm run demo:artifacts`](scripts/demo-artifacts.ts), which drives the real tools, browser,
store, report generator and UI with **scripted (non-LLM) agents** against the seeded-bug demo site.
Full results screen: [docs/demo/03-results.png](docs/demo/03-results.png) · sample report: [docs/demo/sample-report.html](docs/demo/sample-report.html).

## Architecture

```mermaid
flowchart LR
  UI[Web UI / eve client] -->|RUN id + objective| O
  subgraph eve agent
    O[Orchestrator<br/>start_run · save_plan · delegate · run_status · finish_run]
    O -- delegate workflow tool --> E[Explorer]
    O --> T[Tester]
    O --> I[Investigator]
    O --> R[Reporter]
  end
  E & T & I -->|role-scoped tools| B[Playwright browser<br/>isolated context per run]
  B --> S[(Target site<br/>origin allowlist)]
  O & E & T & I & R <-->|ids only| ST[(Run store: state, plan, navmap,<br/>checks, findings, actions, screenshots)]
  R --> REP[report.html + report.json]
```

Key properties (full reasoning in [docs/ADR-001-architecture.md](docs/ADR-001-architecture.md)):

- **One delegation path.** The root agent has no built-in `agent` tool and no default tools. Its only way to
  delegate is the `delegate` workflow tool, which calls `ctx.agent(role).send(msg, { outputSchema })`.
  Subagents are declared (`agent/subagents/*`), hidden from the model (`tool: false`), and inherit nothing.
- **Bounded context.** A subagent receives a hard-capped (6000 chars) message built in code: role, one task,
  its slice of state, evidence **ids** (never content). It returns a zod-validated handoff (≤600-char
  summary). Page content stays in the run store; screenshots are never fed back to models.
- **Budgets enforced in code**, not prompts: browser actions per task, retries per task key, delegation depth,
  agent invocations, elapsed time, single active task, de-duplication of completed tasks. Token/cost caps use
  eve's own `limits`. The reporter is exempt from time/invocation budgets so an exhausted run still reports.
- **observed → suspected → confirmed.** A failed check creates a finding (`observed`, or `suspected` if the
  tester blames the product). Only the Investigator can `confirm`, and the store refuses unless it cites
  browser evidence it produced **in its own task**. Reports are generated from the store; the Reporter agent
  can only add narrative and grouping.
- **Safety in tool code**: origin allowlist (also applied to every in-browser request and redirect), no
  destructive/transactional clicks, no payment fields, no HTTP DELETE, no file upload, dialogs never confirm,
  one fresh browser context per run, credentials by secret *name* only and redacted everywhere.

## Quick start

Requires Node ≥ 24 and Chromium (Playwright pinned to 1.56; set `GHOST_USER_CHROMIUM_PATH` to use an existing one).

```bash
npm install
npx playwright install chromium     # or set GHOST_USER_CHROMIUM_PATH
cp .env.example .env                # then export the variables (or use your shell/direnv)
export GHOST_USER_ALLOWED_ORIGINS=http://127.0.0.1:4173
export GHOST_USER_SECRETS='{"demo_password":"demo-pass-123"}'   # optional: demo login
# model credential (pick one; never commit it):
export GHOST_USER_PROVIDER=anthropic          # direct API; or leave unset for the Vercel AI Gateway
export ANTHROPIC_API_KEY=...                  # enter it in your shell or a git-ignored .env, not in code

npm run demo      # terminal 1: demo site with 4 seeded bugs on :4173
npm run dev       # terminal 2: eve agent server on :2000 (or `eve dev` TUI)
npm run ui        # terminal 3: UI on http://127.0.0.1:4200
```

Open the UI, enter `http://127.0.0.1:4173`, and an objective such as *"Verify signup, project
rename, navigation and the contact form work as a user expects."* The execution screen shows the current
task, active subagent, the browser timeline, suspected failures and budget progress from live store data.

Without the UI: `npm run dev` and chat with the orchestrator, e.g. `Test http://127.0.0.1:4173/ and check signup and the contact form.` (it calls `start_run` itself).

### Demo site

`fixtures/demo-site/` ("Acme Projects") has four intentional, reproducible defects, toggled in the fixture
and never mentioned in any prompt: signup rejects `+` emails; project rename reports success but doesn't
persist; the Settings link opens Billing; the contact form shows success after an HTTP 422. It also has a
"Delete project" trap that must never be clicked (`snapshot().deleteAttempts` must stay 0).
`tsx fixtures/demo-site/server.ts --bugs=none` runs it clean. Ground truth lives in
`fixtures/demo-site/expected-defects.json` (tests/evals only).

## Configuration

The UI binds to 127.0.0.1 only and rejects foreign `Host` headers and cross-site/origin-less POSTs.

See [.env.example](.env.example). Highlights: `GHOST_USER_ALLOWED_ORIGINS` (required; nothing is testable
without it), `GHOST_USER_SECRETS`, `GHOST_USER_MODEL`, the five `GHOST_USER_MAX_*` budgets, `GHOST_USER_MAX_INPUT_TOKENS`
/ `GHOST_USER_MAX_COST_USD` (eve limits), `GHOST_USER_RUNS_DIR`.
When eve's token/cost limit prompt fires during a UI run, the run is stopped (unattended runs don't auto-continue).

## Testing

```bash
npm run typecheck && npm run lint
npm test                      # 68 tests: unit + real-browser e2e against the demo site (scripted agents)
npm run eval:mock             # eve runtime wiring with deterministic mock models
GHOST_USER_REAL_EVAL=1 GHOST_USER_PROVIDER=anthropic npm run eval -- real-model   # needs ANTHROPIC_API_KEY; NOT yet run
```

Exact commands and recorded outcomes: [docs/TESTING.md](docs/TESTING.md).

## Efficiency tracking

Reports include agent invocations, tool calls, browser actions and runtime from code counters. Token usage and
cost come from eve's `session.*` events (recorded by the UI) and are shown **only when reported**
(otherwise "not reported"). No token-savings or baseline-comparison numbers are claimed: no baseline was run.

## Known limitations

- **No live-model validation yet.** Agent prompts, snapshot ergonomics and model behaviour under real
  conditions are untested. Defect detection/false-positive rates for real agents are unmeasured.
- The e2e test and screenshots use scripted agents. They validate plumbing (tools, gates, evidence, report), not intelligence.
- Local single-process design: the run store is files in `runs/` with an in-process lock; the browser
  registry is process-global. Not designed for multi-instance serverless deployment as-is.
- Authentication flows beyond name/password forms (MFA, OAuth, CAPTCHAs) are not supported.
- Snapshots use an accessibility-oriented DOM summary, not Playwright's ARIA tree; canvas/shadow-DOM-heavy apps will be poorly covered.
- `eve build` requires the `just-bash` dev dependency (sandbox provider initialisation) even though no agent uses a sandbox.
- Requires `modelContextWindowTokens` to be set explicitly (done) when the AI Gateway catalogue is unreachable.
- Vercel-specific contribution acceptance criteria are unknown; see [docs/SUBMISSION.md](docs/SUBMISSION.md).

## License

Apache-2.0 (proposed; confirm before publishing). Authorised-use only: run Ghost User solely against sites you own or have permission to test.
