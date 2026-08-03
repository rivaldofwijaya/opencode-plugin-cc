import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, isAlive, spawnDetached, terminate, TERMINATE_GRACE_MS } from '../../scripts/lib/process.mjs'
import {
  createJob,
  readJob,
  updateJob,
  writeResult,
} from '../../scripts/lib/tracked-jobs.mjs'
import { jobDir, readJson, writeJson } from '../../scripts/lib/state.mjs'
import { refsPath } from '../../scripts/lib/broker-endpoint.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const WORKER_EXIT_WAIT_MARGIN_MS = 1000

function observeChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onExit = () => {
      child.off('error', onError)
      resolve()
    }
    const onError = (error) => {
      child.off('exit', onExit)
      reject(error)
    }

    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function waitForChildExit(child, observed, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`worker ${child.pid} did not emit an exit event within ${timeoutMs}ms`))
    }, timeoutMs)
    observed.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

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

test('status lists a job with its id, verb, state, time, and target', async () => {
  const s = await sandbox()
  const job = await record(s.env, {
    verb: 'review',
    cwd: '/workspace/review-target',
    meta: { scope: 'branch', base: 'main' },
    state: 'done',
    result: 'done output',
  })
  const r = await cli(s.env, s.home, ['status'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, new RegExp(job.id))
  assert.match(r.stdout, /review/)
  assert.match(r.stdout, /done/)
  assert.match(r.stdout, /started|ago|s\)/i)
  assert.match(r.stdout, /cwd=\/workspace\/review-target/)
  assert.match(r.stdout, /scope=branch/)
  assert.match(r.stdout, /base=main/)
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
  const job = await record(s.env, { cwd: '/workspace/task-target', state: 'done', result: 'task output' })
  const r = await cli(s.env, s.home, ['result', job.id])
  assert.equal(r.code, 0)
  assert.match(r.stdout, new RegExp(`opencode task ${job.id}`))
  assert.match(r.stdout, /done/)
  assert.match(r.stdout, /started|ended/i)
  assert.match(r.stdout, /cwd=\/workspace\/task-target/)
  assert.match(r.stdout, /task output/)
})

test('result formats a finished review and preserves its truncated warning', async () => {
  const s = await sandbox()
  const job = await record(s.env, {
    verb: 'review',
    cwd: '/workspace/review-target',
    state: 'done',
    meta: { scope: 'working-tree', base: null, truncated: true },
    result: JSON.stringify({ summary: 'findings', findings: [] }),
  })
  const r = await cli(s.env, s.home, ['result', job.id])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /findings/)
  assert.match(r.stdout, /truncated/i)
  assert.match(r.stdout, new RegExp(job.id))
  assert.match(r.stdout, /cwd=\/workspace\/review-target/)
  assert.match(r.stdout, /scope=working-tree/)
  assert.match(r.stdout, /base=none/)
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
  const running = await record(s.env, { state: undefined, result: 'captured response text' })
  const runningEmpty = await record(s.env, { state: undefined })
  const finished = await record(s.env, { state: 'done' })

  const runningResult = await cli(s.env, s.home, ['result', running.id])
  assert.equal(runningResult.code, 0)
  assert.match(runningResult.stdout, /still running/i)
  assert.match(runningResult.stdout, /partial tail/i)
  assert.match(runningResult.stdout, /captured response text/)
  assert.match(runningResult.stdout, new RegExp(running.id))

  const runningEmptyResult = await cli(s.env, s.home, ['result', runningEmpty.id])
  assert.equal(runningEmptyResult.code, 0)
  assert.match(runningEmptyResult.stdout, /still running/i)
  assert.match(runningEmptyResult.stdout, /no output yet/i)
  assert.match(runningEmptyResult.stdout, new RegExp(runningEmpty.id))

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
    assert.match(r.stdout, new RegExp(`${state} cause`))
    assert.match(r.stdout, /no output was produced/i)
  })
}

test('result on an unknown job exits 1 with a self-describing error', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['result', 'job_nope'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /unknown job: job_nope/)
  assert.match(r.stderr, /status/)
  assert.equal(r.stdout, '')
})

test('result refuses a job from another Claude Code session', async () => {
  const s = await sandbox()
  const job = await record(s.env, { ccSessionId: 'cc-b', state: 'done', result: 'secret' })
  const r = await cli({ ...s.env, CLAUDE_SESSION_ID: 'cc-a' }, s.home, ['result', job.id])
  assert.equal(r.code, 1)
  assert.match(r.stderr, new RegExp(`job ${job.id} belongs to a different Claude Code session`))
  assert.equal(r.stdout, '')
  assert.doesNotMatch(r.stderr, /secret/)
})

test('cancel on an unknown job exits 1 with a self-describing error', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['cancel', 'job_nope'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /unknown job: job_nope/)
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
    const job = await record(s.env)
    await updateJob(job.id, { pid: foreign.pid, sessionID: 'foreign-session' }, s.env)
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
  const mismatchedJob = await record(s.env)
  const mismatchedToken = 'expected-worker-token'
  const mismatchedWorker = spawnDetached(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
    '--',
    '--opencode-job-worker', mismatchedJob.id, 'different-worker-token',
  ])
  let worker
  const job = await record(s.env)
  const workerToken = 'verified-worker-token'
  worker = spawnDetached(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
    '--',
    '--opencode-job-worker', job.id, workerToken,
  ])
  const workerExited = observeChildExit(worker)
  try {
    await writeFile(join(jobDir(mismatchedJob.id, s.env), 'worker-owner.json'), JSON.stringify({
      jobId: mismatchedJob.id,
      pid: mismatchedWorker.pid,
      workerToken: mismatchedToken,
    }))
    await updateJob(mismatchedJob.id, { pid: mismatchedWorker.pid }, s.env)
    const mismatchedResult = await cli(s.env, s.home, ['cancel', mismatchedJob.id])
    assert.equal(mismatchedResult.code, 0)
    assert.match(mismatchedResult.stdout, /cancelled/i)
    assert.equal((await readJob(mismatchedJob.id, s.env)).state, 'cancelled')
    assert.equal(isAlive(mismatchedWorker.pid), true)

    await writeFile(join(jobDir(job.id, s.env), 'worker-owner.json'), JSON.stringify({
      jobId: job.id,
      pid: worker.pid,
      workerToken,
    }))
    await updateJob(job.id, { pid: worker.pid }, s.env)
    await writeJson(refsPath(s.env), {
      [s.env.CLAUDE_SESSION_ID]: {
        [workerToken]: { pid: worker.pid, at: Date.now() },
      },
    })
    const psDir = join(s.home, 'bin')
    await mkdir(psDir)
    await writeFile(join(psDir, 'ps'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_PS_COMMAND"\n')
    await chmod(join(psDir, 'ps'), 0o755)
    const r = await cli({
      ...s.env,
      PATH: `${psDir}:${s.env.PATH}`,
      FAKE_PS_COMMAND: `${process.execPath} --opencode-job-worker ${job.id} ${workerToken}`,
    }, s.home, ['cancel', job.id])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /cancelled/i)
    await waitForChildExit(worker, workerExited, TERMINATE_GRACE_MS + WORKER_EXIT_WAIT_MARGIN_MS)
    assert.equal(worker.exitCode !== null || worker.signalCode !== null, true)
    assert.equal((await readJson(refsPath(s.env), {}))[s.env.CLAUDE_SESSION_ID]?.[workerToken], undefined)
  } finally {
    if (isAlive(mismatchedWorker.pid)) await terminate(mismatchedWorker.pid, { graceMs: 1000 })
    if (isAlive(worker.pid)) await terminate(worker.pid, { graceMs: 1000 })
  }
})

test('cancel --all reports an empty running set without an empty successful command', async () => {
  const s = await sandbox()
  const r = await cli(s.env, s.home, ['cancel', '--all'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /nothing.*running|nothing.*cancel/i)
})
