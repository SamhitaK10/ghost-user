# Project summary (Stanford CS 146S)

## Summary
Ghost User is an open-source autonomous website-testing system built on Vercel's eve. An orchestrator delegates
bounded tasks to four declared subagents (Explorer, Tester, Investigator, Reporter) through a single workflow tool
that enforces budgets, retries, routing and de-duplication in code. Browser work uses Playwright with an origin
allowlist, destructive-action refusal and secret-by-name credentials. Findings move observed → suspected →
confirmed, and the store refuses confirmation unless the Investigator reproduced the failure itself with browser
evidence; reports are generated from stored facts so they cannot cite evidence that does not exist.
A separate demo site with four seeded defects supports repeatable tests. Verified: 71 unit and end-to-end tests (real Chromium,
scripted agents), a 13-gate mock-model eve eval through the real runtime, and `eve build`. Live-model results are not
yet recorded, so no detection-rate or efficiency claims are made. Gemini, Anthropic, OpenAI and AI Gateway models are
supported. AI assistance: developed with Claude Code (see the commit trailers).

## Questions for the eve maintainers
1. Acceptance criteria for a Vercel contribution: does a standalone repo using eve count, or must it be upstreamed (examples/templates)? Is expanding one agent a valid second contribution?
2. eve behaviours to confirm are intended: (a) structured output only via `eve__reply` (a text-JSON reply fails the schema); (b) tool results with `undefined` property values crash the serializer; (c) `eve build` fails without the optional `just-bash` package even when no sandbox is used; (d) `eve info` fails offline unless `modelContextWindowTokens` is set.
3. Is a root agent whose only delegation route is a workflow tool (`tool:false`, `defaultTools:false`) a supported pattern for enforcing budgets?
4. Preferred way to expose per-session usage to tools/UI (we read `data.usage` from stream events)?
5. Licence expectations (Apache-2.0 proposed) and whether the demo site may live in the repo.
