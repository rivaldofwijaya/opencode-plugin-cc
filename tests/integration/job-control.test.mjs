import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, isAlive, terminate } from '../../scripts/lib/process.mjs'
import { startJob, runForeground, cancelJob } from '../../scripts/lib/job-control.mjs'
import { readJob, readEvents, readResult, lastOpencodeSession } from '../../scripts/lib/tracked-jobs.mjs'
import { shutdownBroker } from '../../scripts/lib/broker-lifecycle.mjs'

const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const repoCwd = fileURLToPath(new URL('../..', import.meta.url))

const sandbox = async (extra = {}) => ({
  ...process.env,
  OPENCODE_BIN: fixture,
  XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocjc-')),
  HOME: '/nonexistent',
  ...extra,
})

const bindFailure = (error) => /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(String(error?.message || error))

async function stopJob(jobId, env) {
  const job = jobId ? await readJob(jobId, env) : null
  if (job?.pid && job.pid !== process.pid && isAlive(job.pid)) {
    await terminate(job.pid, { graceMs: 1000 })
  }
  await shutdownBroker(env)
}

test('a foreground job runs to done and captures text, events, and counters', async (t) => {
  const env = await sandbox()
  let job
  try {
    job = await runForeground({
      ccSessionId: 'cc-1', verb: 'review', prompt: 'review', cwd: repoCwd, env,
    })
    assert.equal(job.state, 'done')
    assert.ok(job.pid === process.pid)
    assert.ok(job.counters.steps >= 1)
    assert.ok(job.counters.tools >= 1)
    assert.ok(job.counters.outputTokens > 0)
    const result = await readResult(job.id, env)
    assert.match(result, /"findings"/)
    assert.ok((await readEvents(job.id, env)).length > 0)
    assert.equal(await lastOpencodeSession('cc-1', env), job.sessionID)
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return
    }
    throw error
  } finally {
    await stopJob(job?.id, env)
  }
})

test('a background start returns immediately and settles later', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '80' })
  let jobId
  try {
    const started = await startJob({
      ccSessionId: 'cc-1', verb: 'review', prompt: 'p', cwd: repoCwd, env,
    })
    jobId = started.jobId
    assert.equal((await readJob(jobId, env)).state, 'running')
    const settled = await started.done
    assert.equal(settled.state, 'done')
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return
    }
    throw error
  } finally {
    await stopJob(jobId, env)
  }
})

test('cancelJob aborts a running foreground job', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '300' })
  let jobId
  try {
    const started = await startJob({
      ccSessionId: 'cc-1', verb: 'task', prompt: 'p', cwd: repoCwd, background: false, env,
    })
    jobId = started.jobId
    assert.equal(await cancelJob(jobId, env), 'cancelled')
    const settled = await started.done
    assert.equal(settled.state, 'cancelled')
    assert.equal((await readJob(jobId, env)).state, 'cancelled')
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return
    }
    throw error
  } finally {
    await stopJob(jobId, env)
  }
})

test('cancelJob on an unknown id reports unknown', async () => {
  const env = await sandbox()
  assert.equal(await cancelJob('job_nope', env), 'unknown')
})

test('an SSE disconnect mid-job reconnects and reaches a terminal state', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_FAULT: 'sse-disconnect' })
  let job
  try {
    job = await runForeground({
      ccSessionId: 'cc-1', verb: 'review', prompt: 'p', cwd: repoCwd, env,
    })
    assert.ok(['done', 'failed'].includes(job.state))
    assert.ok((await readEvents(job.id, env)).length > 0, 'partial events must survive the disconnect')
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return
    }
    throw error
  } finally {
    await stopJob(job?.id, env)
  }
})

test('a detached background worker completes after its launcher exits', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '20' })
  let jobId
  try {
    const jobControlUrl = new URL('../../scripts/lib/job-control.mjs', import.meta.url).href
    const launcher = `
      import { startJob } from ${JSON.stringify(jobControlUrl)}
      const started = await startJob({
        ccSessionId: 'cc-1',
        verb: 'review',
        prompt: 'background review',
        cwd: process.cwd(),
        background: true,
      })
      process.stdout.write(JSON.stringify({ launcherPid: process.pid, ...started, done: undefined }))
    `
    const launched = await run(process.execPath, ['--input-type=module', '--eval', launcher], {
      cwd: repoCwd,
      env,
      timeoutMs: 15000,
    })
    assert.equal(launched.code, 0, launched.stderr)
    const launchRecord = JSON.parse(launched.stdout)
    jobId = launchRecord.jobId
    assert.match(jobId, /^job_/)

    const reader = `
      import { readJob, readEvents, readResult } from ${JSON.stringify(new URL('../../scripts/lib/tracked-jobs.mjs', import.meta.url).href)}
      const id = ${JSON.stringify(jobId)}
      const deadline = Date.now() + 15000
      let job
      while (Date.now() < deadline) {
        job = await readJob(id, process.env)
        if (job && job.state !== 'running') break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const result = await readResult(id, process.env)
      const events = await readEvents(id, process.env)
      process.stdout.write(JSON.stringify({ job, result, eventCount: events.length }))
    `
    const observed = await run(process.execPath, ['--input-type=module', '--eval', reader], {
      cwd: repoCwd,
      env,
      timeoutMs: 20000,
    })
    assert.equal(observed.code, 0, observed.stderr)
    const report = JSON.parse(observed.stdout)
    assert.equal(report.job.state, 'done')
    assert.ok(report.job.pid > 0)
    assert.notEqual(report.job.pid, launchRecord.launcherPid)
    assert.ok(report.eventCount > 0)
    assert.match(report.result, /"findings"/)
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return
    }
    throw error
  } finally {
    await stopJob(jobId, env)
  }
})
