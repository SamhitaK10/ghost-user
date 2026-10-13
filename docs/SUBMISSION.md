# CS 146S submission prep (draft: nothing has been submitted)

Nothing here has been sent to, or accepted by, any maintainer. Do not treat it as such.

## Contribution writeup (draft, ~250 words)
Ghost User is an open-source autonomous website-testing system built on Vercel's eve. An orchestrator delegates
bounded tasks to four declared subagents (Explorer, Tester, Investigator, Reporter) through a single workflow tool
that enforces budgets, retries, routing and de-duplication in code. Browser work uses Playwright with an origin
allowlist, destructive-action refusal and secret-by-name credentials. Findings move observed → suspected →
confirmed, and the store refuses confirmation unless the Investigator reproduced the failure itself with browser
evidence; reports are generated from stored facts so they cannot cite evidence that does not exist.
A separate demo site with four seeded defects supports repeatable tests. Verified: 68 unit/e2e tests (real Chromium,
scripted agents), a mock-model eve eval through the real runtime, `eve build`. Not verified: any live-model run,
so no detection-rate or efficiency claims are made. Integration findings worth sharing with eve maintainers are in
the questions below. AI assistance: the code, tests and docs were produced with Claude Code and **must be reviewed by
the author before submission** (course policy on unreviewed AI output).

## Questions for maintainers (Shar Dara, Andrew Qu)
1. Acceptance criteria for a Vercel contribution: does a standalone repo using eve count, or must it be upstreamed (examples/templates)? Is expanding one agent a valid second contribution?
2. Deadlines assumed if Vercel is the first partner: Oct 18 (contribution 1), Nov 8 (2), Dec 10 (final). Please confirm.
3. eve behaviours to confirm are intended: (a) structured output only via `eve__reply` (a text-JSON reply fails the schema); (b) tool results with `undefined` property values crash the serializer; (c) `eve build` fails without the optional `just-bash` package even when no sandbox is used; (d) `eve info` fails offline unless `modelContextWindowTokens` is set.
4. Is a root agent whose only delegation route is a workflow tool (`tool:false`, `defaultTools:false`) a supported pattern for enforcing budgets?
5. Preferred way to expose per-session usage to tools/UI (we read `data.usage` from stream events)?
6. Licence expectations (Apache-2.0 proposed) and whether the demo site may live in the repo.

## Before you submit (your tasks)
- Provide a model credential (see README) and run a real-model session and `GHOST_USER_REAL_EVAL=1 npm run eval -- real-model`; record the numbers in docs/TESTING.md.
- Read and understand all code; remove anything you cannot defend. Confirm licence and copyright holder.
- Create the GitHub repo and push (not done; no git repo exists yet). Do not commit `.env`.
- Replace README status text once real-model results exist.
