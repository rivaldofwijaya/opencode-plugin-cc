import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, isAlive, terminate } from '../../scripts/lib/process.mjs'
import { startJob, runForeground, cancelJob } from '../../scripts/lib/job-control.mjs'
import {
  createJob,
  listJobs,
  readJob,
  readEvents,
  readResult,
  lastOpencodeSession,
  updateJob,
  updateJobMeta,
  writeResult,
  jobLockPath,
} from '../../scripts/lib/tracked-jobs.mjs'
import {
  acquireLock,
  acquireLockAt,
  readEndpoint,
  refsPath,
  releaseLock,
  releaseLockAt,
} from '../../scripts/lib/broker-endpoint.mjs'
import { jobDir, readJson } from '../../scripts/lib/state.mjs'
import { spawnTracked } from '../helpers/process-cleanup.mjs'

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
  if (!jobId) return
  await cancelJob(jobId, env).catch(() => {})
}

async function waitForJobInTest(jobId, env) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const job = await readJob(jobId, env)
    if (job && job.state !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for job ${jobId}`)
}

test('a foreground job runs to done and captures text, events, and counters', async (t) => {
  const env = await sandbox()
  const startingRefs = await readJson(refsPath(env), {})
  let job
  try {
    job = await runForeground({
      ccSessionId: 'cc-1', verb: 'review', prompt: 'review', cwd: repoCwd, env,
    })
    assert.equal(job.state, 'done')
    assert.ok(job.pid === process.pid)
    assert.ok(job.counters.steps >= 1)
    assert.equal(job.counters.tools, 0)
    assert.ok(job.counters.outputTokens > 0)
    const result = await readResult(job.id, env)
    assert.match(result, /"findings"/)
    assert.ok((await readEvents(job.id, env)).length > 0)
    assert.equal(await lastOpencodeSession('cc-1', env), job.sessionID)
    assert.deepEqual(await readJson(refsPath(env), {}), startingRefs)
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

test('a foreground failure releases its broker reference', async (t) => {
  const env = await sandbox()
  const scriptPath = join(env.XDG_STATE_HOME, 'failure-events.jsonl')
  await writeFile(scriptPath, `${JSON.stringify({
    type: 'session.error',
    properties: { error: { name: 'UnknownError', data: { message: 'fixture failure detail' } } },
  })}\n`)
  const startingRefs = await readJson(refsPath(env), {})
  let job
  try {
    job = await runForeground({
      ccSessionId: 'cc-failure',
      verb: 'review',
      prompt: 'p',
      cwd: repoCwd,
      env: { ...env, FAKE_OPENCODE_SCRIPT: scriptPath },
    })
    assert.equal(job.state, 'failed')
    assert.equal(job.error, 'fixture failure detail')
    assert.deepEqual(await readJson(refsPath(env), {}), startingRefs)
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

test('a foreground startup failure releases its broker reference', async () => {
  const env = await sandbox({ FAKE_OPENCODE_FAULT: 'nonzero-exit' })
  const startingRefs = await readJson(refsPath(env), {})
  await assert.rejects(
    () => startJob({
      ccSessionId: 'cc-startup-failure',
      verb: 'review',
      prompt: 'p',
      cwd: repoCwd,
      background: false,
      env,
    }),
    /opencode broker exited|would not start/,
  )
  assert.deepEqual(await readJson(refsPath(env), {}), startingRefs)
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

test('a fast worker with a terminal record does not make startJob throw', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '0' })
  let jobId
  let launch
  try {
    launch = startJob({
      ccSessionId: 'cc-fast-worker',
      verb: 'review',
      prompt: 'fast background review',
      cwd: repoCwd,
      env,
    })

    const deadline = Date.now() + 5000
    let jobs = []
    while (Date.now() < deadline && !jobs.length) {
      jobs = await listJobs('cc-fast-worker', env)
      if (!jobs.length) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(jobs.length, 1, 'the launcher must create a durable job record')
    jobId = jobs[0].id

    // Simulate a worker that completes before the launcher's next handoff poll.
    await writeResult(jobId, 'simulated fast-worker result', env)
    await updateJob(jobId, { state: 'done', endedAt: Date.now(), error: null }, env)

    const started = await launch
    assert.equal(started.jobId, jobId)
    assert.equal((await started.done).state, 'done')
    assert.equal(await readResult(jobId, env), 'simulated fast-worker result')
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

test('concurrent terminal and metadata updates preserve both fields', async () => {
  const env = await sandbox()
  const job = await createJob({
    ccSessionId: 'cc-concurrent-record',
    verb: 'review',
    cwd: repoCwd,
    background: true,
    meta: { scope: 'working-tree' },
  }, env)

  await Promise.all([
    updateJob(job.id, { state: 'done', endedAt: Date.now(), error: null }, env),
    updateJobMeta(job.id, { truncated: true }, env),
  ])

  const final = await readJob(job.id, env)
  assert.equal(final.state, 'done')
  assert.equal(final.meta.truncated, true)
})

test('different job record locks do not serialize writes', async () => {
  const env = await sandbox()
  const first = await createJob({
    ccSessionId: 'cc-independent-records',
    verb: 'review',
    cwd: repoCwd,
    background: true,
  }, env)
  const second = await createJob({
    ccSessionId: 'cc-independent-records',
    verb: 'review',
    cwd: repoCwd,
    background: true,
  }, env)
  const firstLock = jobLockPath(first.id, env)
  assert.equal(await acquireLockAt(firstLock), true)

  let firstSettled = false
  const firstUpdate = updateJob(first.id, { state: 'done', endedAt: Date.now() }, env)
    .then((value) => {
      firstSettled = true
      return value
    }, (error) => {
      firstSettled = true
      throw error
    })

  try {
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(firstSettled, false)
    const secondFinished = await Promise.race([
      updateJobMeta(second.id, { truncated: true }, env).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ])
    assert.equal(secondFinished, true)
    assert.equal(firstSettled, false)
  } finally {
    await releaseLockAt(firstLock)
  }

  await firstUpdate
  assert.equal((await readJob(first.id, env)).state, 'done')
  assert.equal((await readJob(second.id, env)).meta.truncated, true)
})

test('a job record write is independent of the broker lock', async () => {
  const env = await sandbox()
  const job = await createJob({
    ccSessionId: 'cc-broker-lock-independent',
    verb: 'review',
    cwd: repoCwd,
    background: true,
  }, env)
  assert.equal(await acquireLock(env), true)
  try {
    await updateJob(job.id, { state: 'done', endedAt: Date.now() }, env)
  } finally {
    await releaseLock(env)
  }
  assert.equal((await readJob(job.id, env)).state, 'done')
})

test('a stale job record lock is reclaimed', async () => {
  const env = await sandbox()
  const job = await createJob({
    ccSessionId: 'cc-stale-record-lock',
    verb: 'review',
    cwd: repoCwd,
    background: true,
  }, env)
  await writeFile(jobLockPath(job.id, env), JSON.stringify({ pid: 2 ** 22, at: Date.now() }))

  await updateJob(job.id, { state: 'done', endedAt: Date.now() }, env)
  assert.equal((await readJob(job.id, env)).state, 'done')
})

test('cancelJob aborts a running foreground job', async (t) => {
  const env = await sandbox({
    FAKE_OPENCODE_EVENT_DELAY_MS: '300',
  })
  const requestLog = join(env.XDG_STATE_HOME, 'foreground-cancel-requests.jsonl')
  env.FAKE_OPENCODE_REQUEST_LOG = requestLog
  const startingRefs = await readJson(refsPath(env), {})
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
    const requests = (await readFile(requestLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(requests.some((request) => request.type === 'abort' && request.sessionID === started.sessionID))
    assert.deepEqual(await readJson(refsPath(env), {}), startingRefs)
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

test('cancelling one background worker releases only its broker holder', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '1000' })
  let firstId
  let secondId
  try {
    const first = await startJob({
      ccSessionId: 'cc-shared-workers',
      verb: 'task',
      prompt: 'cancel this worker',
      cwd: repoCwd,
      env,
    })
    firstId = first.jobId
    const second = await startJob({
      ccSessionId: 'cc-shared-workers',
      verb: 'task',
      prompt: 'keep this worker',
      cwd: repoCwd,
      env,
    })
    secondId = second.jobId

    const firstJob = await readJob(firstId, env)
    const secondJob = await readJob(secondId, env)
    const firstOwner = await readJson(join(jobDir(firstId, env), 'worker-owner.json'), null)
    const secondOwner = await readJson(join(jobDir(secondId, env), 'worker-owner.json'), null)
    assert.ok(firstJob?.pid > 0)
    assert.ok(secondJob?.pid > 0)
    assert.notEqual(firstOwner?.workerToken, secondOwner?.workerToken)

    const before = await readJson(refsPath(env), {})
    assert.ok(before['cc-shared-workers']?.[firstOwner.workerToken])
    assert.ok(before['cc-shared-workers']?.[secondOwner.workerToken])

    assert.equal(await cancelJob(firstId, env), 'cancelled')

    const after = await readJson(refsPath(env), {})
    assert.equal(after['cc-shared-workers']?.[firstOwner.workerToken], undefined)
    assert.deepEqual(
      after['cc-shared-workers']?.[secondOwner.workerToken],
      before['cc-shared-workers']?.[secondOwner.workerToken],
    )
    assert.equal((await readJob(secondId, env)).state, 'running')
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return
    }
    throw error
  } finally {
    await stopJob(firstId, env)
    await stopJob(secondId, env)
  }
})

test('cancelJob does not signal a foreign PID', async (t) => {
  const env = await sandbox()
  const foreign = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  try {
    const job = await createJob({
      ccSessionId: 'cc-foreign', verb: 'task', cwd: repoCwd, background: true,
    }, env)
    await updateJob(job.id, { pid: foreign.pid }, env)
    assert.equal(await cancelJob(job.id, env), 'cancelled')
    assert.equal((await readJob(job.id, env)).state, 'cancelled')
    assert.equal(isAlive(foreign.pid), true)
  } finally {
    if (isAlive(foreign.pid)) await terminate(foreign.pid, { graceMs: 1000 })
  }
})

test('cancelJob on an unknown id reports unknown', async () => {
  const env = await sandbox()
  assert.equal(await cancelJob('job_nope', env), 'unknown')
})

test('cancelJob does not abort an unowned session', async () => {
  const env = await sandbox()
  const job = await createJob({
    ccSessionId: 'cc-unowned-session',
    verb: 'task',
    cwd: repoCwd,
    background: true,
  }, env)
  await updateJob(job.id, { pid: process.pid, sessionID: 'session-owned-elsewhere' }, env)
  const aborted = []
  const ensureBrokerFn = async () => ({
    client: {
      abort: async (sessionID) => { aborted.push(sessionID) },
    },
  })

  assert.equal(await cancelJob(job.id, env, { ensureBrokerFn }), 'cancelled')
  assert.deepEqual(aborted, [])
  assert.equal((await readJob(job.id, env)).state, 'cancelled')
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

test('worker acquires its own ref before the launcher exits', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '500' })
  let jobId
  try {
    const jobControlUrl = new URL('../../scripts/lib/job-control.mjs', import.meta.url).href
    const launcher = `
      import { startJob } from ${JSON.stringify(jobControlUrl)}
      const started = await startJob({
        ccSessionId: 'cc-handoff',
        verb: 'review',
        prompt: 'background handoff',
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

    const request = await readJson(join(jobDir(jobId, env), 'worker.json'), null)
    const owner = await readJson(join(jobDir(jobId, env), 'worker-owner.json'), null)
    const refs = await readJson(refsPath(env), {})
    const holders = refs['cc-handoff']
    assert.ok(holders && typeof holders === 'object')
    assert.deepEqual(holders[request.workerToken], {
      pid: owner.pid,
      at: holders[request.workerToken].at,
    })
    assert.notEqual(owner.pid, launchRecord.launcherPid)

    const endpoint = await readEndpoint(env)
    assert.ok(endpoint && isAlive(endpoint.pid), 'broker must survive launcher exit')

    const settled = await waitForJobInTest(jobId, env)
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

test('a detached background worker completes after its launcher exits', async (t) => {
  const env = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '20' })
  const startingRefs = await readJson(refsPath(env), {})
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
    assert.deepEqual(await readJson(refsPath(env), {}), startingRefs)
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
