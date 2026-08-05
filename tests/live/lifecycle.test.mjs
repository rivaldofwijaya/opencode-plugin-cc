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
