import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isAlive, run } from '../../../src/lib/process.mjs'
import { readJob } from '../../../src/lib/tracked-jobs.mjs'
import { companion, live, model, toolModel, liveEnv, repo, pollStatus, jobLine, jobState } from './helpers.mjs'

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
  assert.ok(
    result.stdout.includes(`opencode task ${jobId} — done`),
    `result ${jobId} omitted its completed header:\n${result.stdout}`,
  )
  assert.ok(
    result.stdout.split('\n').includes(`Target: cwd=${await realpath(d)}`),
    `result ${jobId} omitted its target line:\n${result.stdout}`,
  )
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
  assert.ok(
    cancelled.stdout.includes(`Cancelled task ${jobId}; state is cancelled`),
    `cancel did not take the cancelled branch (the job likely finished first): ${cancelled.stdout}`,
  )

  for (let attempt = 0; attempt < 40 && isAlive(workerPid); attempt += 1) await sleep(250)
  assert.equal(isAlive(workerPid), false, `worker ${workerPid} survived cancel of ${jobId}`)

  const after = await readJob(jobId, env)
  assert.equal(after?.state, 'cancelled', `job record was not cancelled: ${JSON.stringify(after)}`)
})

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
  assert.ok(written.includes(TOOL_PROBE_TEXT), `the tool-created file had unexpected contents: ${written}`)

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
