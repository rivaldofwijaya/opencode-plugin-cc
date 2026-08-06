# Widening live coverage

Date: 2026-08-05
Status: approved design, not yet implemented

## Problem

`tests/live/smoke.test.mjs` holds two tests, `review --wait` and `task --wait`,
against a real opencode server. Everything else the plugin does has only ever
been exercised against `tests/fake-opencode-fixture.mjs`.

That distinction is not academic here. The last live run found two critical
defects that 405 green fixture tests could not see: the product listened for
`session.next.*` events the real server never emits, and the review verb
requested an agent that existed only as a Claude Code subagent. The fixture
encoded the product's own wrong assumptions, so the suite was self-consistent
and said nothing about reality.

Two gaps follow from that, in priority order.

**The background path has never touched a real server.** Both live tests pass
`--wait`, which runs the job in-process. `--background` hands the job to a
detached broker, and `status` / `result` / `cancel` then operate on it through
persisted state. The broker's stream accumulation, its job-state persistence,
and the identity gate that guards signalling all live on that path. All three
have unit coverage against the fixture and none against a real process.

**The `tool` counter is ungrounded.** `renderJobList` reports `N tools` from
`job.counters.tools`, but no run has ever observed a real tool part. It is
untested by construction, the same shape of defect as the event-name bug.

## Non-goals

`setup` and `rescue` get no new live tests, deliberately.

- `rescue` is not a companion verb. `commands/rescue.md` drives the `task`
  verb, which is already live-covered.
- `setup` is not a companion verb either. `commands/setup.md` drives `doctor`,
  `gate` and `repair`. The isolated setup ladder covers `doctor`; `repair` runs
  on every live test's `afterEach` cleanup and would fail the suite loudly if it
  broke.

Tests named after those two commands would grow the coverage checklist without
grounding anything that is not already grounded.

Also out of scope: asserting on the *content* of any model response. Live
assertions stay structural, because content assertions against a real model are
how live suites become flaky.

## Design

### File layout

`tests/live/` splits into three files, all picked up by the existing
`npm run test:live` glob (`tests/live/**/*.test.mjs`) with no script change:

| File | Holds |
| --- | --- |
| `tests/live/helpers.mjs` | shared scaffolding (not a test file) |
| `tests/live/smoke.test.mjs` | unchanged: `review --wait`, `task --wait` |
| `tests/live/lifecycle.test.mjs` | background chain (two jobs), tool counter |
| `tests/live/verbs.test.mjs` | `adversarial-review`, `transfer` |

The `repo()`, `liveEnv()` and `afterEach` cleanup scaffolding currently in
`smoke.test.mjs` is 75 of its 110 lines. It moves verbatim to `helpers.mjs` and
all three test files import it. Duplicating a cleanup path three ways is how
cleanup paths rot; one copy keeps the `repair` sweep authoritative.

`helpers.mjs` gains one new export:

```
pollStatus(env, cwd, predicate, { timeoutMs, intervalMs })
```

It runs `companion status` on an interval and resolves with the stdout of the
first run whose output satisfies `predicate`. On timeout it rejects with a
message containing the last stdout it saw, so a failure reports the state the
job was actually in rather than only that time ran out.

### Background lifecycle: two jobs

`cancel` needs a job that is still running; `result` needs one that finished.
One job cannot serve both without one of the two assertions becoming
conditional, so the chain is split across two jobs. The cost is one extra model
call.

**Job A: completion chain.** In a fresh repo:

1. `task --background --model <m> -- <short prompt>`; parse the job id out of
   `Started task as <jobId>.`
2. `pollStatus` until that job id appears with state `running`.
3. `pollStatus` until it reports a finished state.
4. `result <jobId>`: assert exit code 0 and that the rendered output carries
   the model's answer.

Step 4 is the first time a real model stream is accumulated by a detached
broker rather than in-process, which makes it the first real test of the
broker's handling of `message.part.delta`.

**Job B: cancel chain.** In a fresh repo:

1. `task --background` with a prompt that generates sustained output, so the
   job is reliably still running when cancel fires.
2. `pollStatus` until state is `running`; capture the broker/child pid from
   job state.
3. `cancel <jobId>`: assert stdout matches the cancelled branch
   (`Cancelled task <jobId>; state is cancelled`), not the
   `had already finished ... nothing to cancel` branch. Asserting the specific
   branch is what stops this test from passing on a job that simply finished
   first.
4. Assert the spawned process is actually gone, not merely that the state file
   says `cancelled`.

Step 4 is the point of this test. The identity gate and signal path have unit
coverage against a fixture but have never signalled a real opencode process.

Both jobs are backgrounded and so are swept by the `repair` already in
`afterEach`.

### Tool counter

In a fresh repo, `task --wait` with a prompt that requires writing a specific
named file.

1. Assert the file exists on disk with the expected content. This is the ground
   truth that a tool actually ran.
2. Only then assert the rendered output reports a non-zero tool count.

The order matters. If the file is absent the test fails with a message saying
the model did not call a tool, a model or configuration problem, so a weak
model never reads as a counter regression. If the file is present and the
counter is zero, that is a real counter defect.

The default live model (`gpt-oss-20b:free`) may not call tools reliably. This
one test reads `OPENCODE_LIVE_TOOL_MODEL`, falling back to
`OPENCODE_LIVE_MODEL`, so it can be pointed at a stronger model without
changing the rest of the suite.

### adversarial-review

Same shape as the existing live review test, through the adversarial path: seed
a flaw in the repo, run `adversarial-review --wait --model <m>`, assert exit
code 0 and that the output renders as a review.

Exit code 0 is a real assertion here, not a formality: `reviewExitCode` returns
`GAP` when the job failed or cancelled *or* when the model's output did not
parse against the review schema. Findings do not affect it. So a 0 proves the
adversarial prompt produced schema-valid output from a real model, which is
exactly the thing a fixture cannot prove. It does not assert any particular
finding.

### transfer

After a real `task` has created an opencode session in the test's Claude Code
session, run `transfer --out <path>` and assert the file is written and parses
into a handoff that references that real opencode session id. No model call of
its own beyond the preceding task.

## Testing and cost

All new tests carry the same `{ skip: !live && 'set OPENCODE_LIVE=1 to run' }`
guard as the existing two, so `npm test` is unaffected and the suite stays
opt-in.

Five additional real model calls (job A, job B, tool counter,
adversarial-review, and the task that precedes transfer). Expected wall clock
is in the several-minutes range. Per-test timeouts stay at the existing
300000ms; the polling helpers get their own shorter timeouts so a stuck poll
fails with a state report rather than being swallowed by the outer timeout.

## Risks

- **Job B racing to completion before cancel fires.** Mitigated by asserting on
  the cancelled branch specifically, so the race surfaces as a failure rather
  than a false pass. If it proves flaky the prompt gets longer, not the
  assertion looser.
- **Free-tier model weakness on tool use.** Mitigated by the side-effect-first
  assertion order and the `OPENCODE_LIVE_TOOL_MODEL` override.
- **These tests still run only on this machine, on macOS, with no CI.** This
  work widens what a live run covers; it does not change how often one happens.
