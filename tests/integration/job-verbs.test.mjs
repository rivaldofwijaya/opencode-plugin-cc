import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, isAlive, spawnDetached, terminate } from '../../scripts/lib/process.mjs'
import {
  createJob,
  readJob,
  updateJob,
  writeResult,
} from '../../scripts/lib/tracked-jobs.mjs'
import { jobDir } from '../../scripts/lib/state.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocjv-'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-a',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env, home }
}

const cli = (env, cwd, args) => run(process.execPath, [companion, ...args], { env, cwd, timeoutMs: 60000 })

async function record(env, options = {}) {
  const job = await createJob({
    ccSessionId: options.ccSessionId ?? env.CLAUDE_SESSION_ID,
    verb: options.verb ?? 'task',
    cwd: options.cwd ?? env.HOME,
    background: options.background ?? true,
    meta: options.meta ?? {},
  }, env)
  if (options.state) {
    await updateJob(job.id, {
      state: options.state,
      endedAt: options.endedAt ?? Date.now(),
      error: options.error ?? null,
      ...(options.pid === undefined ? {} : { pid: options.pid }),
    }, env)
  }
  if (options.result !== undefined) await writeResult(job.id, options.result, env)
  return readJob(job.id, env)
}

test('status reports no jobs on a fresh session', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['status'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /No opencode jobs for this Claude Code session/)
  assert.equal(r.stderr, '')
})

test('status lists a job with its id, verb, state, and start time', async () => {
  const s = await sandbox()
  const job = await record(s.env, { verb: 'task', state: 'done', result: 'done output' })
  const r = await cli(s.env, s.home, ['status'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, new RegExp(job.id))
  assert.match(r.stdout, /task/)
  assert.match(r.stdout, /done/)
  assert.match(r.stdout, /started|ago|s\)/i)
})

test('status lists only jobs belonging to the current Claude Code session', async () => {
  const s = await sandbox()
  const mine = await record(s.env, { state: 'done' })
  const foreign = await record(s.env, { ccSessionId: 'cc-b', state: 'done' })
  const r = await cli(s.env, s.home, ['status'])
  assert.match(r.stdout, new RegExp(mine.id))
  assert.doesNotMatch(r.stdout, new RegExp(foreign.id))
})

test('result prints a finished task output with job context', async () => {
  const s = await sandbox()
  const job = await record(s.env, { state: 'done', result: 'task output' })
  const r = await cli(s.env, s.home, ['result', job.id])
  assert.equal(r.code, 0)
  assert.match(r.stdout, new RegExp(`opencode task ${job.id}`))
  assert.match(r.stdout, /done/)
  assert.match(r.stdout, /started|ended/i)
  assert.match(r.stdout, /task output/)
})

test('result formats a finished review and preserves its truncated warning', async () => {
  const s = await sandbox()
  const job = await record(s.env, {
    verb: 'review',
    state: 'done',
    meta: { scope: 'working-tree', base: null, truncated: true },
    result: JSON.stringify({ summary: 'findings', findings: [] }),
  })
  const r = await cli(s.env, s.home, ['result', job.id])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /findings/)
  assert.match(r.stdout, /truncated/i)
  assert.match(r.stdout, new RegExp(job.id))
})

test('result distinguishes a finished review that produced no output', async () => {
  const s = await sandbox()
  const job = await record(s.env, { verb: 'review', state: 'done' })
  const r = await cli(s.env, s.home, ['result', job.id])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /no output was produced/i)
  assert.match(r.stdout, new RegExp(job.id))
})

test('result distinguishes a running job with no result from a finished job with no output', async () => {
  const s = await sandbox()
  const running = await record(s.env, { state: undefined })
  const finished = await record(s.env, { state: 'done' })

  const runningResult = await cli(s.env, s.home, ['result', running.id])
  assert.equal(runningResult.code, 0)
  assert.match(runningResult.stdout, /still running/i)
  assert.match(runningResult.stdout, /no output yet/i)
  assert.match(runningResult.stdout, new RegExp(running.id))

  const finishedResult = await cli(s.env, s.home, ['result', finished.id])
  assert.equal(finishedResult.code, 0)
  assert.match(finishedResult.stdout, /done/)
  assert.match(finishedResult.stdout, /no output was produced/i)
  assert.match(finishedResult.stdout, new RegExp(finished.id))
})

for (const state of ['failed', 'cancelled', 'timed-out']) {
  test(`result identifies a job in the ${state} state without rendering an empty command`, async () => {
    const s = await sandbox()
    const job = await record(s.env, { state, error: `${state} cause` })
    const r = await cli(s.env, s.home, ['result', job.id])
    assert.equal(r.code, 0)
    assert.match(r.stdout, new RegExp(job.id))
    assert.match(r.stdout, new RegExp(state))
    assert.match(r.stdout, /no output|failed|cancelled|timed out/i)
  })
}

test('result on an unknown job exits 1 with a self-describing error', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['result', 'job_nope'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /unknown job: job_nope/)
  assert.equal(r.stdout, '')
})

test('result refuses a job from another Claude Code session', async () => {
  const s = await sandbox()
  const job = await record(s.env, { ccSessionId: 'cc-b', state: 'done', result: 'secret' })
  const r = await cli({ ...s.env, CLAUDE_SESSION_ID: 'cc-a' }, s.home, ['result', job.id])
  assert.equal(r.code, 1)
  assert.match(r.stderr, new RegExp(`job ${job.id} belongs to a different Claude Code session`))
  assert.equal(r.stdout, '')
})

test('cancel --all changes only running jobs in the current session', async () => {
  const s = await sandbox()
  const mine = await record(s.env)
  const mineDone = await record(s.env, { state: 'done' })
  const foreign = await record(s.env, { ccSessionId: 'cc-b' })
  const r = await cli(s.env, s.home, ['cancel', '--all'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, new RegExp(mine.id))
  assert.doesNotMatch(r.stdout, new RegExp(foreign.id))
  assert.match(r.stdout, /cancelled/i)
  assert.equal((await readJob(mine.id, s.env)).state, 'cancelled')
  assert.equal((await readJob(mineDone.id, s.env)).state, 'done')
  assert.equal((await readJob(foreign.id, s.env)).state, 'running')
})

test('cancel reports a finished job as an idempotent no-op', async () => {
  const s = await sandbox()
  const job = await record(s.env, { state: 'done', result: 'finished' })
  const before = await readJob(job.id, s.env)
  const r = await cli(s.env, s.home, ['cancel', job.id])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /already finished|nothing to cancel/i)
  assert.match(r.stdout, new RegExp(job.id))
  assert.match(r.stdout, /started/i)
  assert.deepEqual(await readJob(job.id, s.env), before)
})

test('cancel refuses a job from another Claude Code session', async () => {
  const s = await sandbox()
  const job = await record(s.env, { ccSessionId: 'cc-b' })
  const r = await cli(s.env, s.home, ['cancel', job.id])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /different Claude Code session/)
  assert.equal((await readJob(job.id, s.env)).state, 'running')
})

test('cancel does not signal a running process without verified worker ownership', async () => {
  const s = await sandbox()
  const foreign = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  try {
    const job = await record(s.env, { pid: foreign.pid })
    const r = await cli(s.env, s.home, ['cancel', job.id])
    assert.equal(r.code, 0)
    assert.match(r.stdout, new RegExp(job.id))
    assert.match(r.stdout, /started/i)
    assert.equal((await readJob(job.id, s.env)).state, 'cancelled')
    assert.equal(isAlive(foreign.pid), true)
  } finally {
    if (isAlive(foreign.pid)) await terminate(foreign.pid, { graceMs: 1000 })
  }
})

test('cancel signals a worker only when its owner record and command line agree', async () => {
  const s = await sandbox()
  const job = await record(s.env)
  const workerToken = 'verified-worker-token'
  const worker = spawnDetached(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
    '--opencode-job-worker', job.id, workerToken,
  ])
  try {
    await writeFile(join(jobDir(job.id, s.env), 'worker-owner.json'), JSON.stringify({
      jobId: job.id,
      pid: worker.pid,
      workerToken,
    }))
    await updateJob(job.id, { pid: worker.pid }, s.env)
    const r = await cli(s.env, s.home, ['cancel', job.id])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /cancelled/i)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && isAlive(worker.pid)) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(isAlive(worker.pid), false)
  } finally {
    if (isAlive(worker.pid)) await terminate(worker.pid, { graceMs: 1000 })
  }
})

test('cancel --all reports an empty running set without an empty successful command', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['cancel', '--all'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /nothing.*running|nothing.*cancel/i)
})
