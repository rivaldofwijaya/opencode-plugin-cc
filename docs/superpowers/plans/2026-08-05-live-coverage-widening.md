# Widening Live Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `tests/live/` so a live run exercises the background job lifecycle (`--background` → `status` → `result` / `cancel`), the `tool` counter, `adversarial-review`, and `transfer` against a real opencode server.

**Architecture:** The scaffolding currently inlined in `tests/live/smoke.test.mjs` (`repo()`, `liveEnv()`, the `repair` `afterEach`) moves verbatim into a new non-test module `tests/live/helpers.mjs`, which also gains a `pollStatus` poller and small status-line parsers. Two new test files import it: `lifecycle.test.mjs` (background completion chain, background cancel chain, tool counter) and `verbs.test.mjs` (`adversarial-review`, `transfer`). Every new test carries the same `OPENCODE_LIVE=1` skip guard, so `npm test` is untouched.

**Tech Stack:** Node 22 ESM, `node:test`, `node:assert/strict`, the repo's own `scripts/lib/process.mjs` (`run`, `isAlive`) and `scripts/lib/tracked-jobs.mjs` (`readJob`, `lastOpencodeSession`). No new dependencies.

## Global Constraints

- Node `>=22`; all files are ESM `.mjs`. No new npm dependencies — tests use `node:test` and `node:assert/strict` only.
- Code style matches the existing codebase: 2-space indent, single quotes, **no semicolons**, arrow-function helpers, `import` at top of file.
- Every live test is guarded with `{ skip: !live && 'set OPENCODE_LIVE=1 to run' }` and a per-test `timeoutMs: 300000` on companion invocations. `npm test` must stay unaffected.
- The live glob (`tests/live/**/*.test.mjs`) stays as-is. `helpers.mjs` deliberately does not end in `.test.mjs` so it is not collected as a test file.
- Default live model: `process.env.OPENCODE_LIVE_MODEL || 'openrouter/openai/gpt-oss-20b:free'`. The tool-counter test alone reads `OPENCODE_LIVE_TOOL_MODEL` first, falling back to that same value.
- Live assertions are **structural only** — never assert on the semantic content of a model response beyond a single word the prompt pins down.
- Cleanup lives in exactly one place: the `afterEach` in `helpers.mjs`. Do not duplicate a cleanup path into a test file.
- Commit messages use conventional-commit prefixes (`test:`, `feat:`, `docs:`), matching the repo's history.

## Verification Commands

Two commands gate every task:

1. **Skip-mode** (free, no network, always runnable):
   `node --test 'tests/live/**/*.test.mjs'` — with `OPENCODE_LIVE` unset every live test must report as skipped and the run must exit 0. This proves the file parses, the imports resolve, and the guard works.
2. **Live** (spends tokens, requires a working `opencode` binary + credentials):
   `npm run test:live`

If the machine executing this plan has no opencode credentials, run (1) on every task, run (2) once at the end, and **say explicitly in the completion report which of the two was actually run** — a live test that has only been run in skip mode is unverified. Never report a live test as passing on the strength of a skip.

## File Structure

| File | Responsibility |
| --- | --- |
| `tests/live/helpers.mjs` | **Create.** Shared live scaffolding: `companion`, `live`, `model`, `toolModel`, `repo()`, `liveEnv()`, `pollStatus()`, `jobLine()`, `jobState()`, and the single `repair` + tmpdir `afterEach`. Not a test file. |
| `tests/live/smoke.test.mjs` | **Modify.** Drops the scaffolding, imports it from `helpers.mjs`. Its two tests are unchanged. |
| `tests/live/lifecycle.test.mjs` | **Create.** Job A (background completion chain), Job B (background cancel chain), tool counter. |
| `tests/live/verbs.test.mjs` | **Create.** `adversarial-review`, `transfer`. |
| `package.json` | **Modify.** `test:live` gains `--test-concurrency=1`. |
| `README.md` | **Modify.** The testing table's live row describes the widened coverage. |

## Deviations from the design, and why

Three places where this plan does not follow the spec literally. Each is a deliberate call; if you disagree, raise it before implementing rather than silently reverting.

1. **`package.json` gets a one-word change** (`--test-concurrency=1`), which the design said would not be needed. The design is right that the glob picks up the new files with no script change — but going from one live file to three means `node --test` runs them in parallel by default, and they share one broker, one state root, and one `repair` sweep (`repair` is process-global: `reapOrphans` + `pruneStale` across all jobs). Three concurrent live files also triple peak token spend. Serializing is one flag and removes a whole class of cross-file interference.
2. **Job A does not hard-assert that it observed state `running`.** The design's step 2 polls until `running`; a short prompt can legitimately finish between the `task` invocation returning and the first `status` poll, so that assertion would be a race the test can lose while the product is correct. Job A instead asserts the job id is listed in `status` and then that it reaches `done`. Job B, which genuinely needs a running job, keeps the `running` requirement and mitigates it the way the design prescribes — a sustained-output prompt plus an assertion on the *cancelled* branch, so losing the race is a failure rather than a false pass.
3. **`transfer` costs a model call of its own.** The design says transfer makes "no model call of its own beyond the preceding task", but `transfer` calls `broker.client.promptAsync` to seed the new session (`scripts/opencode-companion.mjs:408`). It is fire-and-forget, so the test does not wait on it, but tokens are spent. Expected live cost is **six** model calls, not five. Relatedly, `buildHandoff` has no opencode-session field, so the handoff file cannot reference the opencode session id; the test asserts the seeded id via stdout and the persisted session record instead, which is the same claim through the channel that actually carries it.

---

### Task 1: Extract shared live scaffolding into `helpers.mjs`

Pure refactor plus one new helper. No new model calls. After this task `npm run test:live` must produce exactly the same two passing tests as before.

**Files:**
- Create: `tests/live/helpers.mjs`
- Modify: `tests/live/smoke.test.mjs` (delete lines 1–84's scaffolding, keep the two tests)
- Modify: `package.json:9` (`test:live` script)

**Interfaces:**
- Consumes: `run` from `scripts/lib/process.mjs` — `run(cmd, args, { cwd, env, timeoutMs }) => Promise<{ code, stdout, stderr, timedOut }>`.
- Produces, all used by Tasks 2–6:
  - `companion: string` — absolute path to `scripts/opencode-companion.mjs`.
  - `live: boolean` — `process.env.OPENCODE_LIVE === '1'`.
  - `model: string`, `toolModel: string`.
  - `repo(): Promise<string>` — fresh git repo in a tmpdir containing `div.js`, registered for cleanup.
  - `liveEnv(extra?: Record<string,string>): Record<string,string>` — env with a unique `CLAUDE_SESSION_ID`, registered for the `repair` sweep.
  - `pollStatus(env, cwd, predicate: (stdout: string) => boolean, opts?: { timeoutMs?: number, intervalMs?: number }): Promise<string>`.
  - `jobLine(stdout: string, jobId: string): string | null`.
  - `jobState(stdout: string, jobId: string): string | null`.

- [ ] **Step 1: Create `tests/live/helpers.mjs`**

Everything from `companion` through the end of `afterEach` is moved verbatim out of `smoke.test.mjs`, with three additions marked below: the `export` keywords, `liveEnv`'s `extra` parameter, and the new poller/parsers.

```js
import { afterEach } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

export const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
export const live = process.env.OPENCODE_LIVE === '1'
export const model = process.env.OPENCODE_LIVE_MODEL || 'openrouter/openai/gpt-oss-20b:free'
// Only the tool-counter test uses this; the free default may not call tools.
export const toolModel = process.env.OPENCODE_LIVE_TOOL_MODEL || model

const repos = new Set()
const liveSessionEnvs = new Set()
let liveSessionCounter = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function liveEnv(extra = {}) {
  const env = {
    ...process.env,
    CLAUDE_SESSION_ID: `cc-live-${process.pid}-${++liveSessionCounter}`,
    ...extra,
  }
  liveSessionEnvs.add(env)
  return env
}

const warn = (message) => {
  try {
    process.stderr.write(`${message}\n`)
  } catch {
    // Cleanup warnings must never turn into a test failure.
  }
}

export async function repo() {
  const d = await mkdtemp(join(tmpdir(), 'oclive-'))
  repos.add(d)
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
    const git = (...a) => run('git', a, { cwd: d, env })
    await git('init', '-b', 'main')
    await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\n')
    await git('add', '.')
    await git('commit', '-m', 'init')
    return d
  } catch (error) {
    repos.delete(d)
    await rm(d, { recursive: true, force: true })
    throw error
  }
}

// A status line is: "  <id>  <verb padded>  <state padded>  <elapsed> ..."
export function jobLine(stdout, jobId) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes(jobId)) return line
  }
  return null
}

export function jobState(stdout, jobId) {
  const line = jobLine(stdout, jobId)
  if (!line) return null
  const fields = line.trim().split(/\s+/)
  return fields[2] ?? null
}

/**
 * Run `companion status` until `predicate` accepts its stdout. On timeout the
 * rejection carries the last status seen, so a stuck poll reports the state the
 * job was actually in rather than only that time ran out.
 */
export async function pollStatus(env, cwd, predicate, { timeoutMs = 240000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let last = '(status never produced output)'
  while (Date.now() < deadline) {
    attempts += 1
    const r = await run(process.execPath, [companion, 'status'], { cwd, env, timeoutMs: 60000 })
    last = `exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.trim() || '(empty)'}`
    if (r.code === 0 && predicate(r.stdout)) return r.stdout
    await sleep(intervalMs)
  }
  throw new Error(`pollStatus gave up after ${timeoutMs}ms and ${attempts} status runs; last status was:\n${last}`)
}

afterEach(async () => {
  const pending = [...repos]
  repos.clear()
  const pendingSessions = [...liveSessionEnvs]
  liveSessionEnvs.clear()

  for (const env of pendingSessions) {
    try {
      const repair = await run(process.execPath, [companion, 'repair'], { env, timeoutMs: 120000 })
      if (repair.code !== 0) {
        warn(
          `[live cleanup] repair failed for ${env.CLAUDE_SESSION_ID}; `
          + `exit code: ${repair.code}; `
          + `stderr: ${repair.stderr.trim() || '(empty)'}`,
        )
      }
    } catch (error) {
      warn(
        `[live cleanup] repair failed for ${env.CLAUDE_SESSION_ID}; `
        + 'exit code: unavailable (repair threw); '
        + `stderr: ${typeof error?.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : '(unavailable)'}; `
        + `error: ${error?.message ?? String(error)}`,
      )
    }
  }

  for (const d of pending) {
    try {
      await rm(d, { recursive: true, force: true })
    } catch (error) {
      warn(`[live cleanup] could not remove repository ${d}: ${error?.message ?? String(error)}`)
    }
  }
})
```

Why the `afterEach` lives here: `node --test` runs each test file in its own process, so importing this module registers the hook on that file's root suite. One copy, three files, one authoritative cleanup path.

- [ ] **Step 2: Replace `tests/live/smoke.test.mjs` with the import-only version**

The two tests below are byte-identical to the current ones; only the preamble changed.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../scripts/lib/process.mjs'
import { companion, live, model, liveEnv, repo } from './helpers.mjs'

test('live: a real review returns findings or a clean report', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\nexport const half = (n) => div(n, 0)\n')
  const env = liveEnv()
  const r = await run(process.execPath, [companion, 'review', '--wait', '--model', model], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /opencode review/)
  assert.ok(r.stdout.length > 40, 'the review produced no meaningful output')
})

test('live: a real task returns model output', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  const env = liveEnv()
  const r = await run(process.execPath, [companion, 'task', '--wait', '--model', model, '--', 'Reply with the single word: ready'], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout.toLowerCase(), /ready/)
})
```

- [ ] **Step 3: Serialize the live suite in `package.json`**

Three live files would otherwise run in parallel against one broker, one state root, and a process-global `repair`.

```json
    "test:live": "OPENCODE_LIVE=1 node --test --test-concurrency=1 'tests/live/**/*.test.mjs'"
```

- [ ] **Step 4: Verify the refactor in skip mode**

Run: `node --test 'tests/live/**/*.test.mjs'`
Expected: exit 0, 2 tests, both reported as skipped with `set OPENCODE_LIVE=1 to run`. `helpers.mjs` must not appear as a test file.

- [ ] **Step 5: Verify `npm test` is unaffected**

Run: `npm test`
Expected: PASS, the same count as before this change.

- [ ] **Step 6: Verify live**

Run: `npm run test:live`
Expected: 2 tests pass. If credentials are unavailable, record that this step was not run.

- [ ] **Step 7: Commit**

```bash
git add tests/live/helpers.mjs tests/live/smoke.test.mjs package.json
git commit -m "test: extract shared live scaffolding into helpers.mjs"
```

---

### Task 2: Job A — background completion chain

First test of a real model stream accumulated by a **detached broker worker** rather than in-process. One model call.

**Files:**
- Create: `tests/live/lifecycle.test.mjs`
- Test: itself

**Interfaces:**
- Consumes: `companion`, `live`, `model`, `liveEnv`, `repo`, `pollStatus`, `jobState` from `./helpers.mjs` (Task 1).
- Produces: nothing consumed by later tasks; Tasks 3 and 4 append tests to this same file.

Behaviour this pins down, read from the source so the assertions match exactly:
- `task --background` prints `Started task as <jobId>. Check it with /opencode:status, ...` (`scripts/opencode-companion.mjs:306`).
- Terminal states are `done`, `failed`, `cancelled`; `stale` and `timed-out` also render (`scripts/lib/render.mjs:38-43`).
- `result <jobId>` prints a header `opencode task <jobId> — <state> (...)`, then `Target: ...`, then a blank line, then the accumulated text (`renderJobResult`, `scripts/lib/render.mjs:134`).

- [ ] **Step 1: Write the failing test**

Create `tests/live/lifecycle.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../../scripts/lib/process.mjs'
import { companion, live, model, liveEnv, repo, pollStatus, jobState } from './helpers.mjs'

const skip = !live && 'set OPENCODE_LIVE=1 to run'
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'timed-out', 'stale'])

function startedJobId(stdout) {
  const match = stdout.match(/Started \S+ as (job_\S+?)\./)
  assert.ok(match, `could not parse a job id out of: ${stdout}`)
  return match[1]
}

test('live: a backgrounded task completes and result reports its output', { skip }, async () => {
  const d = await repo()
  const env = liveEnv()

  const started = await run(
    process.execPath,
    [companion, 'task', '--background', '--model', model, '--', 'Reply with the single word: ready'],
    { cwd: d, env, timeoutMs: 300000 },
  )
  assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`)
  const jobId = startedJobId(started.stdout)

  // The job is tracked as soon as it is listed; insisting on observing
  // "running" here would be a race a short prompt can legitimately lose.
  const listed = await pollStatus(env, d, (out) => jobState(out, jobId) !== null, { timeoutMs: 60000, intervalMs: 1000 })
  assert.ok(jobState(listed, jobId), `job ${jobId} never appeared in status:\n${listed}`)

  const finished = await pollStatus(env, d, (out) => TERMINAL.has(jobState(out, jobId)), { timeoutMs: 240000, intervalMs: 2000 })
  assert.equal(jobState(finished, jobId), 'done', `job ${jobId} did not finish cleanly:\n${finished}`)

  const result = await run(process.execPath, [companion, 'result', jobId], { cwd: d, env, timeoutMs: 300000 })
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, new RegExp(`opencode task ${jobId} — done`))
  assert.match(result.stdout.toLowerCase(), /ready/, `the detached worker accumulated no model text:\n${result.stdout}`)
})
```

The last assertion is the point of the test: `ready` in `result.md` means the detached worker consumed `message.part.delta` / `message.part.updated` from a real server and persisted the joined text.

- [ ] **Step 2: Run in skip mode to verify it parses and skips**

Run: `node --test tests/live/lifecycle.test.mjs`
Expected: exit 0, 1 skipped test.

- [ ] **Step 3: Run live**

Run: `OPENCODE_LIVE=1 node --test --test-concurrency=1 tests/live/lifecycle.test.mjs`
Expected: PASS.

If it fails at the `done` assertion, the `pollStatus` rejection or the state mismatch message carries the last status output — read the state and the `error:` line before changing anything. If it fails at the `/ready/` assertion with state `done`, that is a real broker accumulation defect and is exactly what this test exists to catch; stop and report it rather than loosening the assertion.

- [ ] **Step 4: Commit**

```bash
git add tests/live/lifecycle.test.mjs
git commit -m "test: cover the background completion chain against a real server"
```

---

### Task 3: Job B — background cancel chain

The identity gate and signal path have never signalled a real opencode worker. One model call.

**Files:**
- Modify: `tests/live/lifecycle.test.mjs` (append one test + the new imports)

**Interfaces:**
- Consumes: everything Task 2 imported, plus `isAlive` from `scripts/lib/process.mjs` and `readJob` from `scripts/lib/tracked-jobs.mjs`.
  - `readJob(jobId, env) => Promise<{ id, state, pid, sessionID, ... } | null>` — for a background job, `pid` is the detached worker's pid and stays `null` until that worker claims the job (`scripts/lib/tracked-jobs.mjs:27-29`, `scripts/lib/job-control.mjs:581`).
  - `isAlive(pid) => boolean`.
- Produces: nothing consumed later.

Behaviour pinned down (`scripts/opencode-companion.mjs:521-523`): cancel prints either
`Cancelled task <jobId>; state is cancelled[; started <iso>].`
or `task <jobId> had already finished (state: <state>...); nothing to cancel.`
Asserting the first branch specifically is what stops a job that raced to completion from passing this test.

- [ ] **Step 1: Extend the imports at the top of `tests/live/lifecycle.test.mjs`**

```js
import { isAlive, run } from '../../scripts/lib/process.mjs'
import { readJob } from '../../scripts/lib/tracked-jobs.mjs'
```

(The existing `import { run } from '../../scripts/lib/process.mjs'` is replaced by the first line above; do not leave a duplicate import.)

- [ ] **Step 2: Write the failing test (append to the same file)**

```js
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Long enough that the job is reliably still streaming when cancel fires.
const SUSTAINED_PROMPT = 'Count from 1 to 300. Put each number on its own line, '
  + 'and after each number write one full sentence of at least fifteen words about that number. '
  + 'Do not stop early and do not summarize.'

test('live: cancelling a backgrounded task kills its worker process', { skip }, async () => {
  const d = await repo()
  const env = liveEnv()

  const started = await run(
    process.execPath,
    [companion, 'task', '--background', '--model', model, '--', SUSTAINED_PROMPT],
    { cwd: d, env, timeoutMs: 300000 },
  )
  assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`)
  const jobId = startedJobId(started.stdout)

  await pollStatus(env, d, (out) => jobState(out, jobId) === 'running', { timeoutMs: 60000, intervalMs: 500 })

  // The worker records its own pid once it claims the job.
  let job = await readJob(jobId, env)
  for (let attempt = 0; attempt < 40 && !Number.isInteger(job?.pid); attempt += 1) {
    await sleep(250)
    job = await readJob(jobId, env)
  }
  assert.ok(Number.isInteger(job?.pid) && job.pid > 0, `job ${jobId} never recorded a worker pid: ${JSON.stringify(job)}`)
  assert.equal(job.state, 'running', `job ${jobId} finished before cancel could fire; lengthen SUSTAINED_PROMPT`)
  const workerPid = job.pid
  assert.ok(isAlive(workerPid), `worker ${workerPid} was not alive before cancel`)

  const cancelled = await run(process.execPath, [companion, 'cancel', jobId], { cwd: d, env, timeoutMs: 120000 })
  assert.equal(cancelled.code, 0, `${cancelled.stdout}\n${cancelled.stderr}`)
  assert.match(
    cancelled.stdout,
    new RegExp(`Cancelled task ${jobId}; state is cancelled`),
    `cancel did not take the cancelled branch (the job likely finished first): ${cancelled.stdout}`,
  )

  for (let attempt = 0; attempt < 40 && isAlive(workerPid); attempt += 1) await sleep(250)
  assert.equal(isAlive(workerPid), false, `worker ${workerPid} survived cancel of ${jobId}`)

  const after = await readJob(jobId, env)
  assert.equal(after?.state, 'cancelled', `job record was not cancelled: ${JSON.stringify(after)}`)
})
```

`cancelJob` terminates with `TERMINATE_GRACE_MS` (3s) and escalates to `SIGKILL`, so the 10s poll is slack, not a race. The last assertion is deliberately *after* the process check: the design's point is that a `cancelled` state file is not evidence the process died.

- [ ] **Step 3: Run in skip mode**

Run: `node --test tests/live/lifecycle.test.mjs`
Expected: exit 0, 2 skipped tests.

- [ ] **Step 4: Run live**

Run: `OPENCODE_LIVE=1 node --test --test-concurrency=1 tests/live/lifecycle.test.mjs`
Expected: PASS, 2 tests.

If the cancelled-branch assertion fails because the job finished first, lengthen `SUSTAINED_PROMPT` — never loosen the assertion to accept the `nothing to cancel` branch.

- [ ] **Step 5: Commit**

```bash
git add tests/live/lifecycle.test.mjs
git commit -m "test: prove cancel kills a real detached opencode worker"
```

---

### Task 4: Tool counter

`renderJobList` reports `N tools` from `job.counters.tools`, incremented only for parts of type `tool` (`scripts/lib/job-control.mjs:145-150` — the comment there says outright that no live capture has ever contained a tool part). One model call.

**Files:**
- Modify: `tests/live/lifecycle.test.mjs` (append one test + imports)

**Interfaces:**
- Consumes: as Task 3, plus `readFile` from `node:fs/promises`, `join` from `node:path`, and `toolModel` + `jobLine` from `./helpers.mjs`.
- Produces: nothing consumed later.

- [ ] **Step 1: Extend the imports at the top of `tests/live/lifecycle.test.mjs`**

```js
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { companion, live, model, toolModel, liveEnv, repo, pollStatus, jobLine, jobState } from './helpers.mjs'
```

(Replaces the existing `./helpers.mjs` import line — one import per module.)

- [ ] **Step 2: Write the failing test (append to the same file)**

```js
const TOOL_PROBE_FILE = 'tool-probe.txt'
const TOOL_PROBE_TEXT = 'tool-probe-ok'

test('live: a task that writes a file reports a non-zero tool count', { skip }, async () => {
  const d = await repo()
  const env = liveEnv()

  const r = await run(
    process.execPath,
    [
      companion, 'task', '--wait', '--model', toolModel, '--',
      `Create a file named ${TOOL_PROBE_FILE} in the current directory. `
      + `Its entire contents must be exactly this one line: ${TOOL_PROBE_TEXT}. `
      + 'Use your file-writing tool to create it. Then reply with the single word: done.',
    ],
    { cwd: d, env, timeoutMs: 300000 },
  )
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)

  // Ground truth first: if the file is absent the model never called a tool,
  // which is a model/configuration problem, not a counter regression.
  let written
  try {
    written = await readFile(join(d, TOOL_PROBE_FILE), 'utf8')
  } catch (error) {
    assert.fail(
      `the model did not call a tool: ${TOOL_PROBE_FILE} was never written (${error.code}). `
      + `Set OPENCODE_LIVE_TOOL_MODEL to a model that uses tools reliably. Model output:\n${r.stdout}`,
    )
  }
  assert.match(written, new RegExp(TOOL_PROBE_TEXT))

  // Only now is a zero counter a real defect.
  // This session ran exactly one job, so matching its verb is unambiguous.
  const status = await pollStatus(env, d, (out) => jobLine(out, 'task') !== null, { timeoutMs: 30000, intervalMs: 1000 })
  const line = jobLine(status, 'task')
  assert.ok(line, `no task job was listed for this session:\n${status}`)
  const tools = line.match(/(\d+) tools/)
  assert.ok(
    tools && Number(tools[1]) > 0,
    `a tool ran (${TOOL_PROBE_FILE} exists) but status reported no tool count:\n${line}`,
  )
})
```

Note `renderJobList` omits the counter entirely when it is zero (`counters.tools ? ... : null`), so "no `N tools` fragment" and "zero tools" are the same failure and the message covers both. This session runs exactly one job, so matching the single `task` line is unambiguous.

- [ ] **Step 3: Run in skip mode**

Run: `node --test tests/live/lifecycle.test.mjs`
Expected: exit 0, 3 skipped tests.

- [ ] **Step 4: Run live**

Run: `OPENCODE_LIVE=1 node --test --test-concurrency=1 tests/live/lifecycle.test.mjs`
Expected: PASS, 3 tests.

Two distinct failures, do not conflate them: "the model did not call a tool" → re-run with `OPENCODE_LIVE_TOOL_MODEL` set to a stronger model. "a tool ran but status reported no tool count" → a real defect in `createEventAccumulator().counters()`; stop and report it, do not fix it inside this task.

- [ ] **Step 5: Commit**

```bash
git add tests/live/lifecycle.test.mjs
git commit -m "test: ground the tool counter in a real tool call"
```

---

### Task 5: `adversarial-review` against a real model

`reviewExitCode` returns `GAP` when the job failed or was cancelled **or** when the model's output did not parse against the review schema; findings do not affect it. So exit 0 proves the adversarial prompt produced schema-valid output from a real model. One model call.

**Files:**
- Create: `tests/live/verbs.test.mjs`
- Test: itself

**Interfaces:**
- Consumes: `companion`, `live`, `model`, `liveEnv`, `repo` from `./helpers.mjs`; `run` from `scripts/lib/process.mjs`.
- Produces: the file Task 6 appends to.

- [ ] **Step 1: Write the failing test**

Create `tests/live/verbs.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../scripts/lib/process.mjs'
import { companion, live, model, liveEnv, repo } from './helpers.mjs'

const skip = !live && 'set OPENCODE_LIVE=1 to run'

test('live: a real adversarial review renders a review', { skip }, async () => {
  const d = await repo()
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\nexport const half = (n) => div(n, 0)\n')
  const env = liveEnv()

  const r = await run(process.execPath, [companion, 'adversarial-review', '--wait', '--model', model], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  // Exit 0 means the job finished AND the output parsed against the review
  // schema. It says nothing about which findings came back.
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /opencode review/)
  assert.ok(r.stdout.length > 40, 'the adversarial review produced no meaningful output')
})
```

`renderReview` emits the same `opencode review — <scope>` header for both verbs, which is why the match is `/opencode review/` and not `/adversarial/`.

- [ ] **Step 2: Run in skip mode**

Run: `node --test tests/live/verbs.test.mjs`
Expected: exit 0, 1 skipped test.

- [ ] **Step 3: Run live**

Run: `OPENCODE_LIVE=1 node --test --test-concurrency=1 tests/live/verbs.test.mjs`
Expected: PASS.

A non-zero exit whose stdout contains "could not be parsed as review JSON" means the adversarial prompt did not produce schema-valid output from this model — report it as a finding; that is the defect class this test exists to expose.

- [ ] **Step 4: Commit**

```bash
git add tests/live/verbs.test.mjs
git commit -m "test: cover adversarial-review against a real model"
```

---

### Task 6: `transfer` after a real task

`transfer` writes a handoff, creates a fresh opencode session, seeds it, and records it as the Claude Code session's last opencode session. One model call for the preceding task, plus the fire-and-forget seed prompt.

**Files:**
- Modify: `tests/live/verbs.test.mjs` (append one test + imports)

**Interfaces:**
- Consumes: Task 5's imports, plus `readFile` from `node:fs/promises` and `lastOpencodeSession` from `scripts/lib/tracked-jobs.mjs`.
  - `lastOpencodeSession(ccSessionId, env) => Promise<string | null>` — reads `lastOpencodeSession` from the persisted session record.
- Produces: nothing consumed later.

Behaviour pinned down (`scripts/opencode-companion.mjs:373-443`):
- `--out <path>` writes the handoff to exactly that path.
- Success stdout contains `Handoff written to <path>`, `Seeded opencode session: <id>`, and `opencode --session <id>`.
- `transcriptPath` prefers `CLAUDE_TRANSCRIPT_PATH` when it exists, so the test supplies its own transcript rather than depending on a real `~/.claude/projects` file. Without one the verb still exits 0 but writes a metadata-only handoff, which would not prove the export path works.

- [ ] **Step 1: Extend the imports at the top of `tests/live/verbs.test.mjs`**

```js
import { readFile, writeFile } from 'node:fs/promises'
import { lastOpencodeSession } from '../../scripts/lib/tracked-jobs.mjs'
```

(Replaces the existing `writeFile`-only import — one import per module.)

- [ ] **Step 2: Write the failing test (append to the same file)**

```js
const TRANSCRIPT_MARKER = 'Investigate the divide-by-zero in div.js'

test('live: transfer exports a handoff and seeds a real opencode session', { skip }, async () => {
  const d = await repo()
  const transcript = join(d, 'transcript.jsonl')
  await writeFile(transcript, [
    JSON.stringify({ type: 'user', message: { content: TRANSCRIPT_MARKER } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'half(n) calls div(n, 0), which returns Infinity.' }] } }),
    '',
  ].join('\n'))

  const env = liveEnv({ CLAUDE_TRANSCRIPT_PATH: transcript })

  // A real task first, so the Claude Code session already owns an opencode session.
  const task = await run(
    process.execPath,
    [companion, 'task', '--wait', '--model', model, '--', 'Reply with the single word: ready'],
    { cwd: d, env, timeoutMs: 300000 },
  )
  assert.equal(task.code, 0, `${task.stdout}\n${task.stderr}`)
  const taskSession = await lastOpencodeSession(env.CLAUDE_SESSION_ID, env)
  assert.ok(taskSession, 'the task recorded no opencode session for this Claude Code session')

  const out = join(d, 'handoff.md')
  const r = await run(process.execPath, [companion, 'transfer', '--out', out], { cwd: d, env, timeoutMs: 300000 })
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)

  const handoff = await readFile(out, 'utf8')
  assert.match(handoff, /# Handoff from Claude Code/)
  assert.match(handoff, new RegExp(env.CLAUDE_SESSION_ID))
  assert.match(handoff, new RegExp(TRANSCRIPT_MARKER))

  const seeded = r.stdout.match(/Seeded opencode session: (\S+)/)
  assert.ok(seeded, `transfer reported no seeded session:\n${r.stdout}`)
  assert.match(r.stdout, new RegExp(`opencode --session ${seeded[1]}`))

  // The seeded id is a real server-issued session, now owned by this CC session.
  assert.equal(await lastOpencodeSession(env.CLAUDE_SESSION_ID, env), seeded[1])
})
```

The handoff itself carries no opencode session id (`buildHandoff` has no such field), so the seeded id is asserted through stdout and the persisted session record — the two channels that actually carry it.

- [ ] **Step 3: Run in skip mode**

Run: `node --test tests/live/verbs.test.mjs`
Expected: exit 0, 2 skipped tests.

- [ ] **Step 4: Run live**

Run: `OPENCODE_LIVE=1 node --test --test-concurrency=1 tests/live/verbs.test.mjs`
Expected: PASS, 2 tests.

A non-zero exit with "Transfer completed with partial context" means the handoff omitted content; read which omission it names — the two-line transcript above should produce none.

- [ ] **Step 5: Commit**

```bash
git add tests/live/verbs.test.mjs
git commit -m "test: cover transfer against a real opencode session"
```

---

### Task 7: Full-suite run and README

**Files:**
- Modify: `README.md:39`

- [ ] **Step 1: Run the whole live suite in skip mode**

Run: `node --test 'tests/live/**/*.test.mjs'`
Expected: exit 0, 7 skipped tests (2 smoke + 3 lifecycle + 2 verbs).

- [ ] **Step 2: Run the whole live suite live, end to end**

Run: `npm run test:live`
Expected: 7 tests pass, serialized, in the several-minutes range. This is the run that matters — the per-task live runs above exercised one file at a time and did not prove the files coexist.

- [ ] **Step 3: Confirm the free suites still pass**

Run: `npm test && npm run test:isolated`
Expected: both PASS.

- [ ] **Step 4: Update the README testing table**

Replace the live row:

```markdown
| `OPENCODE_LIVE=1 npm run test:live` | Review, adversarial review, task, the background job lifecycle, the tool counter, and transfer against real credentials | spends tokens |
```

And append to the paragraph below the table:

```markdown
The live suite runs one file at a time; its tests share one broker, one state
root, and one `repair` sweep. `OPENCODE_LIVE_TOOL_MODEL` overrides the model for
the tool-counter test alone, for when the default model does not call tools
reliably.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the widened live coverage"
```

---

## What this plan does not cover

Straight from the design's non-goals, restated so a reviewer does not read these as gaps:

- **No live test named for `setup`.** `commands/setup.md` drives `doctor`, `gate`, and `repair`; the isolated suite covers `doctor`, and `repair` runs in every live test's `afterEach` and fails loudly if it breaks.
- **No live test named for `rescue`.** `commands/rescue.md` drives the `task` verb, which is live-covered twice over.
- **No assertions on model response content**, beyond single words the prompt pins down (`ready`, `done`, `tool-probe-ok`). Content assertions against a real model are how live suites become flaky.
- **These tests still run only on this machine, on macOS, with no CI.** This work widens what a live run covers; it does not change how often one happens.
