# Testing evidence

Recorded 2026-10-13 and re-run 2026-10-15 (Linux, Node 24.21, Playwright 1.56 with Chromium 141, eve 0.78.0).
Everything below was actually run; outputs are summarised from the logs of those runs.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` (oxlint) | 0 warnings, 0 errors |
| `npm test` | **7 files, 71 tests passed (adds Gemini provider selection tests, no network)** |
| `npm run eval:mock` | **1 eval passed, 13/13 gates** |
| `npx eve info` | compile ready, 0 errors/warnings, 5 root tools, 4 subagents |
| `npx eve build` | built `.output` successfully |
| `GHOST_USER_REAL_EVAL=1 npm run eval -- real-model` | Requires your own model key. Without the flag both real-model evals report **skipped**, which is not a pass. No live run is recorded here yet. |

## Live-model results
No live-model detection rates, false-positive rates, browser-action counts, runtimes, token usage or cost are recorded in
this repository, so none are reported; everything above is scripted or mock-model. To produce them (repeat at least three
times and record each run; reports and `usage.json` are under the eval runs dir):

```bash
GHOST_USER_REAL_EVAL=1 GHOST_USER_PROVIDER=gemini GEMINI_API_KEY=... npm run eval -- real-model
```
(`GHOST_USER_PROVIDER=anthropic` or `openai` with the matching key also work.)

## What the 71 tests cover
| File | Tests | Covers |
|---|---|---|
| `test/safety.test.ts` | 23 | origin allowlist, metadata/credential URLs, request filtering, DELETE, destructive/transactional/payment/file controls |
| `test/redact.test.ts` | 4 | secret loading/validation, value + bearer + query redaction, deep redaction |
| `test/store.test.ts` | 24 | persistence, single active task, de-dup, retry limit, invocation/depth/time budgets (reporter exempt), per-task browser-action cap, evidence validation, confirmation gate (tester evidence can't confirm; failed actions aren't evidence), dismissal/inconclusive, concurrent ids, torn log line, stale-task recovery |
| `test/delegate.test.ts` | 13 | routing rules (plan required, nothing-to-investigate), structured-handoff validation, agent crash → failed → retry limit, store facts vs self-report, role tool scoping, bounded context (hard cap, per-role slices, no secrets), start_run refusal, pipeline→report |
| `test/ui-guard.test.ts` | 2 | UI Host/Origin guard (DNS rebinding, cross-site POST) |
| `test/e2e.test.ts` | 2 | **real Chromium against the demo site**, scripted agents through the real delegation/store/tools/report |

### E2E results (scripted agents; validates plumbing, not LLM quality)
- Bugs ON: 4/4 seeded defects confirmed with reproduction steps and screenshots; 0 false positives; the "Delete project" trap was refused by policy and the server recorded 0 delete attempts; no credential string appears anywhere in the run directory; `metrics.model` is `null` (no usage → nothing invented).
- Bugs OFF: 0 failed checks, 0 confirmed findings; overall result is `blocked` (not `passed`) because the destructive-control check is intentionally blocked by policy.

### Bugs found by the tests themselves
1. Single-active-task rule was not enforced (stale-task check was always true). Fixed in `store.reserveTask`; covered by two tests.
2. `browser_snapshot` result lacked `ok`, so every snapshot was logged as failed. Fixed.
3. eve's serializer throws on `undefined` in tool results (found via the first eval run). Fixed with `clean()`.
4. Structured output must be returned via eve's `eve__reply` tool; the first mock eval "passed" while every subagent task was recorded failed, which led to adding task-status gates to the eval.

## Mock eval (`evals/mock-smoke.eval.ts`)
Runs eve's real runtime with scripted models (`GHOST_USER_MOCK=1`): orchestrator → explorer → tester → reporter → `finish_run`.
Gates: run succeeded, tool order, 3 `delegate` calls, no built-in `agent` call, no failed actions, report counts/outcome/summary,
3 invocations, all three tasks `completed`, no dangling active task. This proves wiring (workflow tool, subagent sessions,
output schema, tool scoping, state persistence, report). It says nothing about model quality.

## Not covered / honest gaps
- Real-model behaviour (prompt effectiveness, token use, cost, false-positive/miss rates). `evals/real-model.eval.ts` exists to measure it.
- Playwright against sites other than the demo site; `browser.ts` click/fill failure modes (stale ref, ambiguous selector, disabled element) have no dedicated unit tests beyond the e2e flows.
- UI is verified by running it against a real run directory and viewing screenshots, not by automated UI tests.
- eve `limits` enforcement is eve's feature; it was not exercised here.
