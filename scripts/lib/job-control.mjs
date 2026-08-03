import { randomBytes } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addRef, ensureBroker, releaseRef } from './broker-lifecycle.mjs'
import { atomicWrite } from './fs.mjs'
import { spawnDetached, terminate, isAlive, run, TERMINATE_GRACE_MS } from './process.mjs'
import { jobDir } from './state.mjs'
import { refsPath } from './broker-endpoint.mjs'
import {
  createJob,
  updateJob,
  readJob,
  appendEvent,
  writeResult,
  listJobs,
  rememberOpencodeSession,
} from './tracked-jobs.mjs'
import { readJson } from './state.mjs'

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000]
const STREAM_IDLE_TIMEOUT_MS = 2000
const WORKER_HANDOFF_TIMEOUT_MS = 10_000
const WORKER_FLAG = '--opencode-job-worker'
const WORKER_MODULE = fileURLToPath(import.meta.url)
const TERMINAL_JOB_STATES = new Set(['done', 'failed', 'cancelled'])
const foregroundJobIds = new Set()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class LazyJobPromise extends Promise {
  static get [Symbol.species]() {
    return Promise
  }

  constructor(start) {
    let trigger
    super((resolve, reject) => {
      let started = false
      trigger = () => {
        if (started) return
        started = true
        void Promise.resolve().then(start).then(resolve, reject)
      }
    })
    this.start = trigger
  }

  then(onFulfilled, onRejected) {
    this.start()
    return super.then(onFulfilled, onRejected)
  }
}

function errorText(error) {
  if (typeof error === 'string') return error
  const name = error?.name
  const message = error?.message
  if (name && message) return `${name}: ${message}`
  return message || name || String(error)
}

function eventErrorName(event) {
  return event.properties?.error?.name
    ?? event.properties?.error?.message
    ?? 'UnknownError'
}

function applyCounters(counters, event) {
  if (event.type === 'session.next.step.started') counters.steps += 1
  if (event.type === 'session.next.tool.called') counters.tools += 1
  if (event.type === 'message.updated') {
    const tokens = event.properties?.info?.tokens
    if (tokens) {
      if (tokens.input !== undefined) counters.inputTokens = tokens.input
      if (tokens.output !== undefined) counters.outputTokens = tokens.output
    }
  }
  return counters
}

function promptBody({ prompt, system, agent, model, variant, tools }) {
  const body = { parts: [{ type: 'text', text: prompt }] }
  if (agent) body.agent = agent
  if (variant) body.variant = variant
  if (system) body.system = system
  if (tools) body.tools = tools
  if (model) {
    const slash = String(model).indexOf('/')
    if (slash > 0 && slash < String(model).length - 1) {
      body.model = {
        providerID: String(model).slice(0, slash),
        modelID: String(model).slice(slash + 1),
      }
    }
  }
  return body
}

async function validWorkerCwd(cwd) {
  if (!cwd) return undefined
  try {
    return (await stat(cwd)).isDirectory() ? cwd : undefined
  } catch {
    return undefined
  }
}

async function failJob(jobId, error, env) {
  const current = await readJob(jobId, env)
  if (!current || current.state !== 'running') return current
  const next = await updateJob(jobId, {
    state: 'failed',
    endedAt: Date.now(),
    error: errorText(error),
  }, env)
  await writeResult(jobId, '', env).catch(() => {})
  return next
}

async function holdBrokerRef(ccSessionId, env, holderToken = randomBytes(24).toString('hex')) {
  await addRef(ccSessionId, env, holderToken)
  let releasePromise
  return async () => {
    releasePromise ??= releaseRef(ccSessionId, env, holderToken)
    await releasePromise
  }
}

async function processCommand(pid) {
  try {
    const result = await run('ps', ['-p', String(pid), '-o', 'command='], { timeoutMs: 1000 })
    if (result.code !== 0 || result.timedOut) return null
    return result.stdout.trim()
  } catch {
    return null
  }
}

async function ownedWorkerToken(job, env) {
  if (!job || !Number.isInteger(job.pid) || job.pid <= 0) return false
  const owner = await readJson(join(jobDir(job.id, env), 'worker-owner.json'), null)
  if (!owner
    || owner.jobId !== job.id
    || owner.pid !== job.pid
    || typeof owner.workerToken !== 'string'
    || !owner.workerToken) return false
  if (!isAlive(owner.pid)) return false
  const command = await processCommand(owner.pid)
  if (!command
    || !command.includes(WORKER_FLAG)
    || !command.includes(job.id)
    || !command.includes(owner.workerToken)) return false
  return owner.workerToken
}

async function terminateWorkerAndRelease(ccSessionId, workerPid, workerToken, env, graceMs) {
  try {
    await terminate(workerPid, { graceMs })
  } finally {
    // A killed worker may never run its finally; release its exact token here.
    // releaseRef is idempotent when the worker released it before termination.
    await releaseRef(ccSessionId, env, workerToken)
  }
}

async function writeWorkerOwner(jobId, pid, workerToken, env) {
  await atomicWrite(
    join(jobDir(jobId, env), 'worker-owner.json'),
    JSON.stringify({ jobId, pid, workerToken, startedAt: Date.now() }) + '\n',
  )
}

function beginExecution({ broker, jobId, sessionID, promptOptions, env, releaseBrokerRef }) {
  let controller = null
  let terminal = null
  let persistence = Promise.resolve()
  let persistenceError = null
  let text = ''
  const counters = { steps: 0, tools: 0, inputTokens: 0, outputTokens: 0 }
  let resolveConnected
  const connected = new Promise((resolve) => { resolveConnected = resolve })
  let connectedOnce = false

  const settle = (result) => {
    if (terminal) return
    terminal = result
    controller?.abort()
  }

  const consume = (async () => {
    for (let attempt = 0; attempt <= RECONNECT_DELAYS_MS.length; attempt += 1) {
      const currentController = new AbortController()
      controller = currentController
      let idleTimer = setTimeout(() => currentController.abort(), STREAM_IDLE_TIMEOUT_MS)
      let streamFailed = false
      const refreshIdleTimer = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => currentController.abort(), STREAM_IDLE_TIMEOUT_MS)
      }

      try {
        await broker.client.events({
          signal: currentController.signal,
          onEvent: (event) => {
            if (event.properties?.sessionID && event.properties.sessionID !== sessionID) return
            refreshIdleTimer()
            if (event.type === 'server.connected' && !connectedOnce) {
              connectedOnce = true
              resolveConnected()
            }

            persistence = persistence.then(async () => {
              await appendEvent(jobId, event, env)
              applyCounters(counters, event)
              if (event.type === 'session.next.text.delta' && event.properties?.delta) {
                text += event.properties.delta
              }
            }).catch((error) => {
              persistenceError = error
              settle({ state: 'failed', error: errorText(error) })
            })

            if (event.type === 'session.idle') settle({ state: 'done', error: null })
            if (event.type === 'session.error') {
              const name = eventErrorName(event)
              settle({
                state: name === 'MessageAbortedError' ? 'cancelled' : 'failed',
                error: name,
              })
            }
          },
        })
      } catch (error) {
        streamFailed = true
        if (!terminal && !persistenceError) {
          if (attempt === RECONNECT_DELAYS_MS.length) {
            settle({ state: 'failed', error: `event stream lost: ${errorText(error)}` })
          } else {
            await sleep(RECONNECT_DELAYS_MS[attempt])
          }
        }
      } finally {
        clearTimeout(idleTimer)
      }

      if (terminal || persistenceError) break
      if (!streamFailed && attempt < RECONNECT_DELAYS_MS.length) {
        await sleep(RECONNECT_DELAYS_MS[attempt])
      }
    }

    if (!terminal && !persistenceError) {
      terminal = { state: 'failed', error: 'event stream ended before a terminal event' }
    }

    try {
      await persistence
      const latest = await readJob(jobId, env)
      const state = latest?.state === 'cancelled' ? 'cancelled' : terminal.state
      await writeResult(jobId, text, env)
      await releaseBrokerRef?.()
      return updateJob(jobId, {
        state,
        endedAt: Date.now(),
        error: state === 'done' ? null : (latest?.state === 'cancelled' ? latest.error : terminal.error),
        counters,
      }, env)
    } catch (error) {
      await releaseBrokerRef?.()
      throw error
    }
  })()

  const promptStarted = (async () => {
    await Promise.race([connected, sleep(150)])
    if (terminal) return
    try {
      await broker.client.promptAsync(sessionID, promptBody(promptOptions))
    } catch (error) {
      settle({ state: 'failed', error: errorText(error) })
    }
  })()

  return { promptStarted, done: consume, cancel: () => settle({ state: 'cancelled', error: 'MessageAbortedError' }) }
}

async function writeWorkerRequest(jobId, request, env) {
  await atomicWrite(
    join(jobDir(jobId, env), 'worker.json'),
    JSON.stringify(request, null, 2) + '\n',
  )
}

async function waitForWorkerRef(jobId, ccSessionId, workerToken, workerPid, env) {
  const deadline = Date.now() + WORKER_HANDOFF_TIMEOUT_MS
  while (Date.now() < deadline) {
    const refs = await readJson(refsPath(env), {})
    const holder = refs?.[ccSessionId]?.[workerToken]
    const owner = await readJson(join(jobDir(jobId, env), 'worker-owner.json'), null)
    if (holder?.pid === workerPid && owner?.pid === workerPid && owner.workerToken === workerToken) {
      return holder
    }
    if (!isAlive(workerPid)) {
      const job = await readJob(jobId, env)
      if (TERMINAL_JOB_STATES.has(job?.state)) return job
      throw new Error(`opencode job worker died without recording a result`)
    }
    await sleep(25)
  }
  const finalJob = await readJob(jobId, env)
  if (TERMINAL_JOB_STATES.has(finalJob?.state)) return finalJob
  if (!isAlive(workerPid)) throw new Error(`opencode job worker died without recording a result`)
  throw new Error(`timed out waiting for opencode job worker to acquire broker ref`)
}

async function spawnWorker(jobId, cwd, env, workerToken, onError) {
  const directory = jobDir(jobId, env)
  const stdout = await open(join(directory, 'worker.stdout.log'), 'a')
  let stderr
  try {
    stderr = await open(join(directory, 'worker.stderr.log'), 'a')
    const child = spawnDetached(process.execPath, [WORKER_MODULE, WORKER_FLAG, jobId, workerToken], {
      cwd: await validWorkerCwd(cwd),
      env,
      stdio: ['ignore', stdout.fd, stderr.fd],
    })
    child.once('error', (error) => { void onError(error) })
    return child
  } finally {
    await stderr?.close()
    await stdout.close()
  }
}

async function waitForJob(jobId, env) {
  while (true) {
    const job = await readJob(jobId, env)
    if (!job) throw new Error(`unknown job: ${jobId}`)
    if (job.state !== 'running') return job
    await sleep(50)
  }
}

export async function startJob({
  ccSessionId,
  verb,
  prompt,
  system,
  agent,
  model,
  variant,
  cwd,
  tools,
  resumeSessionID,
  meta,
  background = true,
  onBrokerRefAcquired,
  env = process.env,
}) {
  const job = await createJob({
    ccSessionId,
    verb,
    cwd,
    background,
    meta: { agent, model, variant, ...(meta ?? {}) },
  }, env)
  if (!background) foregroundJobIds.add(job.id)

  let releaseBrokerRef
  let workerOwnsRef = false
  let executionOwnsRef = false
  let launcherRefReleased = false
  const releaseLauncherRef = async () => {
    if (launcherRefReleased) return
    await releaseBrokerRef?.()
    launcherRefReleased = true
  }
  try {
    releaseBrokerRef = await holdBrokerRef(ccSessionId, env)
    onBrokerRefAcquired?.(releaseBrokerRef)
    const broker = await ensureBroker({ env })
    const sessionID = resumeSessionID
      ?? (await broker.client.createSession({
        title: `claude-code ${verb}`,
        ...(agent ? { agent } : {}),
      })).id
    await updateJob(job.id, { sessionID }, env)
    await rememberOpencodeSession(ccSessionId, sessionID, env)

    const promptOptions = { prompt, system, agent, model, variant, tools }
    if (background) {
      const workerToken = randomBytes(24).toString('hex')
      await writeWorkerRequest(job.id, { sessionID, workerToken, ...promptOptions }, env)
      let worker
      try {
        worker = await spawnWorker(job.id, cwd, env, workerToken, async (error) => {
          await failJob(job.id, error, env)
          if (!workerOwnsRef) await releaseLauncherRef()
        })
        await waitForWorkerRef(job.id, ccSessionId, workerToken, worker.pid, env)
        workerOwnsRef = true
        await releaseLauncherRef()
      } catch (error) {
        if (worker?.pid && !workerOwnsRef) {
          await terminateWorkerAndRelease(ccSessionId, worker.pid, workerToken, env, 1000)
        }
        throw error
      }
      return {
        jobId: job.id,
        sessionID,
        done: new LazyJobPromise(() => waitForJob(job.id, env)),
        release: () => releaseBrokerRef?.(),
      }
    }

    const execution = beginExecution({
      broker, jobId: job.id, sessionID, promptOptions, env, releaseBrokerRef,
    })
    executionOwnsRef = true
    void execution.done.then(
      () => foregroundJobIds.delete(job.id),
      () => foregroundJobIds.delete(job.id),
    )
    await execution.promptStarted
    return { jobId: job.id, sessionID, done: execution.done, release: () => releaseBrokerRef?.() }
  } catch (error) {
    foregroundJobIds.delete(job.id)
    if (!executionOwnsRef && (!workerOwnsRef || !launcherRefReleased)) await releaseLauncherRef()
    await failJob(job.id, error, env)
    throw error
  }
}

export async function runForeground(opts) {
  const { done } = await startJob({ ...opts, background: false })
  return done
}

export async function cancelJob(jobId, env = process.env, { ensureBrokerFn = ensureBroker } = {}) {
  const job = await readJob(jobId, env)
  if (!job) return 'unknown'
  if (job.state !== 'running') return 'already-finished'

  await updateJob(jobId, { state: 'cancelled', endedAt: Date.now() }, env)
  const workerToken = await ownedWorkerToken(job, env)
  // Foreground ownership is proven by this process's in-memory start registry.
  // Background jobs need the worker-owner record, a live PID, and a matching command line.
  // If neither proof is available, durable cancellation remains authoritative
  // and no broker session is signalled because it may belong to another job.
  const ownsExecution = foregroundJobIds.has(job.id) || Boolean(workerToken)
  if (job.sessionID && ownsExecution) {
    try {
      const broker = await ensureBrokerFn({ env })
      await broker.client.abort(job.sessionID)
    } catch {
      // The durable cancellation record is authoritative if the broker is gone.
    }
  }
  if (job.pid && job.pid !== process.pid && workerToken) {
    await terminateWorkerAndRelease(job.ccSessionId, job.pid, workerToken, env, TERMINATE_GRACE_MS)
  }
  return 'cancelled'
}

export async function cancelAll(ccSessionId, env = process.env, { preserveLive = false } = {}) {
  const cancelled = []
  for (const job of await listJobs(ccSessionId, env)) {
    if (job.state !== 'running') continue
    if (preserveLive) {
      // SessionEnd records cancellation for its session without terminating a
      // detached worker that may still be legitimate work. The worker's live
      // PID holder keeps the broker protected until it releases itself.
      await updateJob(job.id, { state: 'cancelled', endedAt: Date.now() }, env)
      cancelled.push(job.id)
      continue
    }
    if (await cancelJob(job.id, env) === 'cancelled') cancelled.push(job.id)
  }
  return cancelled
}

async function runWorker(jobId, env, workerToken) {
  let releaseBrokerRef
  let executionOwnsRef = false
  let execution
  let terminationRequested = false
  const onSigterm = () => {
    terminationRequested = true
    execution?.cancel()
  }
  process.once('SIGTERM', onSigterm)

  try {
    const current = await readJob(jobId, env)
    if (!current) return current

    const request = await readJson(join(jobDir(jobId, env), 'worker.json'), null)
    if (!request || request.workerToken !== workerToken) {
      throw new Error(`missing or invalid worker request for ${jobId}`)
    }
    releaseBrokerRef = await holdBrokerRef(current.ccSessionId, env, request.workerToken)
    if (current.state !== 'running') return current
    await writeWorkerOwner(jobId, process.pid, workerToken, env)
    await updateJob(jobId, { pid: process.pid }, env)
    const claimed = await readJob(jobId, env)
    if (!claimed || claimed.state !== 'running') return claimed

    const broker = await ensureBroker({ env })
    execution = beginExecution({
      broker,
      jobId,
      sessionID: request.sessionID,
      promptOptions: request,
      env,
      releaseBrokerRef,
    })
    executionOwnsRef = true
    if (terminationRequested) execution.cancel()
    await execution.promptStarted
    return execution.done
  } catch (error) {
    await failJob(jobId, error, env)
    throw error
  } finally {
    process.removeListener('SIGTERM', onSigterm)
    if (!executionOwnsRef) await releaseBrokerRef?.()
  }
}

if (process.argv[2] === WORKER_FLAG && process.argv[3]) {
  try {
    await runWorker(process.argv[3], process.env, process.argv[4])
  } catch (error) {
    await failJob(process.argv[3], error, process.env).catch(() => {})
    console.error(error.stack || error)
    process.exitCode = 1
  }
}
