import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAlive, run } from '../../scripts/lib/process.mjs'
import { readJob } from '../../scripts/lib/tracked-jobs.mjs'
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
