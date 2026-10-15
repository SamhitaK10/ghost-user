# ADR-001: Ghost User architecture on eve

Status: accepted. Based on eve 0.78.0 docs and source under `node_modules/eve`.

## eve capabilities relied on (all verified in docs/types and by running them)
| Need | eve feature | Evidence |
|---|---|---|
| Specialists with isolated tools/state | declared subagents `agent/subagents/<id>/` (`description` required, `tool:false`, `defaultTools:false`) | `eve info`: 4 subagents, per-role tool counts 8/13/13/3 |
| Controlled delegation + structured output | `defineWorkflowTool` + `ctx.agent(name).send(msg,{outputSchema})` | mock eval 13/13 gates |
| Deterministic body, side effects isolated | `"use workflow"` / `"use step"` | `eve build` succeeds |
| Token/cost caps | `limits.maxInputTokensPerSession`, `maxTokenCostUsdPerSession` | docs/agent-config.md |
| Usage numbers | `data.usage` on `session.waiting/failed/completed` | docs/concepts/sessions-runs-and-streaming.md |
| Deterministic runtime tests | `mockModel`, `eve eval` | `npm run eval:mock` |

Structured output is collected through eve's reserved `eve__reply` tool (found in source after the first
integration attempt recorded all tasks as failed). Tool results must not contain `undefined` values
(eve's serializer throws); all model-facing results pass through `clean()`.

## Decisions
1. **Smallest architecture:** one orchestrator, four subagents, one workflow tool for delegation, a file-backed run store.
   No databases, queues, or extra services. Alternatives rejected: built-in `agent` copies (inherit all tools,
   no budget hook); exposing subagents directly as model tools (no place to enforce routing/budgets); a custom loop outside eve.
2. **Sequential, single active task.** Simplest way to keep budgets and evidence attribution unambiguous; parallelism is a later optimisation.
3. **State outside model context.** `RunStore` (state.json, plan, navmap, checks, findings, actions.jsonl, handoffs.jsonl, screenshots, artifacts). Per-run async lock + atomic rename. Subagents get ids, not content.
4. **Code-enforced gates** in `src/core/store.ts`: reservation (single task, retry, de-dup, depth, invocations, time), `beginToolCall` (role, active task, action cap, timeout), `addCheck` (evidence must exist; failures need evidence), `recordVerdict` (confirmation needs the investigator's own successful browser evidence + severity + steps).
5. **Findings lifecycle:** observed → suspected → confirmed | dismissed (+ inconclusive flag). Reports derive from the store.
6. **Browser tools** use short-lived element refs (`e7`) with a fingerprint check against stale refs, snapshot caching (`unchanged`/`cached` instead of re-sending), outputs truncated, overflow text saved as artifacts, screenshots saved as evidence and never returned to the model.
7. **Safety:** see README. Credentials are referenced by name; the value is resolved in `browser.fill` and redacted from logs/evidence.
8. **Model selection** via `GHOST_USER_PROVIDER` and `GHOST_USER_MODEL` (Gemini, Anthropic, OpenAI or AI Gateway); `GHOST_USER_MOCK=1` swaps in scripted models for evals only.
9. **UI** is a thin local server reading the same store and consuming eve's stream via `eve/client`; binds 127.0.0.1.

## Consequences / risks
- Store and browser registry are in-process: eve dev/start single instance only. Multi-instance needs a shared store and browser service.
- `runId` is passed by the model to tools (validated against the active task); a wrong id is refused, not misrouted.
- Prompt quality with live models is not yet measured (see TESTING.md).
