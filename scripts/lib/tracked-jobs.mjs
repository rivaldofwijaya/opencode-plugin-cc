import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  jobsDir,
  jobDir,
  sessionsDir,
  readJson,
  writeJson,
  appendJsonl,
  readJsonl,
  ensureDir,
} from './state.mjs'
import { atomicWrite } from './fs.mjs'
import { isAlive } from './process.mjs'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function newJobId() {
  return `job_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

// pid is the process that owns job execution: process.pid for a foreground
// job, or the detached worker PID for a background job. A background record
// intentionally keeps pid null until that worker has started.
function recordShape({ id, ccSessionId, verb, cwd, pid, startedAt, meta }) {
  return {
    id,
    ccSessionId,
    verb,
    cwd,
    state: 'running',
    sessionID: null,
    pid,
    startedAt,
    endedAt: null,
    error: null,
    counters: { steps: 0, tools: 0, inputTokens: 0, outputTokens: 0 },
    meta,
  }
}

export async function createJob(
  { ccSessionId, verb, cwd, meta = {}, pid = process.pid, background = false },
  env = process.env,
) {
  const job = recordShape({
    id: newJobId(),
    ccSessionId,
    verb,
    cwd,
    pid: background ? null : pid,
    startedAt: Date.now(),
    meta,
  })
  await ensureDir(jobDir(job.id, env))
  await writeJson(join(jobDir(job.id, env), 'meta.json'), job)
  return job
}

export const readJob = (jobId, env = process.env) => (
  readJson(join(jobDir(jobId, env), 'meta.json'), null)
)

export async function updateJob(jobId, patch, env = process.env) {
  const current = await readJob(jobId, env)
  if (!current) throw new Error(`unknown job: ${jobId}`)
  const next = { ...current, ...patch }
  await writeJson(join(jobDir(jobId, env), 'meta.json'), next)
  return next
}

export async function updateJobMeta(jobId, patch, env = process.env) {
  const current = await readJob(jobId, env)
  if (!current) throw new Error(`unknown job: ${jobId}`)
  return updateJob(jobId, { meta: { ...(current.meta ?? {}), ...patch } }, env)
}

export async function listJobs(ccSessionId, env = process.env) {
  let ids
  try {
    ids = await readdir(jobsDir(env))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const jobs = []
  for (const id of ids) {
    const job = await readJob(id, env)
    if (job?.ccSessionId === ccSessionId) jobs.push(job)
  }
  return jobs.sort((a, b) => b.startedAt - a.startedAt)
}

export const appendEvent = (jobId, event, env = process.env) => (
  appendJsonl(join(jobDir(jobId, env), 'events.jsonl'), event)
)

export const readEvents = (jobId, env = process.env) => (
  readJsonl(join(jobDir(jobId, env), 'events.jsonl'))
)

export async function writeResult(jobId, text, env = process.env) {
  await ensureDir(jobDir(jobId, env))
  await atomicWrite(join(jobDir(jobId, env), 'result.md'), String(text))
}

export async function readResult(jobId, env = process.env) {
  try {
    return await readFile(join(jobDir(jobId, env), 'result.md'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const sessionFile = (ccSessionId, env) => (
  join(sessionsDir(env), `${encodeURIComponent(ccSessionId)}.json`)
)

export async function registerSession(ccSessionId, env = process.env) {
  const path = sessionFile(ccSessionId, env)
  const existing = await readJson(path, null)
  await writeJson(path, {
    ccSessionId,
    registeredAt: existing?.registeredAt ?? Date.now(),
    lastOpencodeSession: existing?.lastOpencodeSession ?? null,
  })
}

export async function unregisterSession(ccSessionId, env = process.env) {
  await rm(sessionFile(ccSessionId, env), { force: true })
}

export async function knownSessions(env = process.env) {
  let files
  try {
    files = await readdir(sessionsDir(env))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => decodeURIComponent(file.slice(0, -5)))
    .sort()
}

export async function rememberOpencodeSession(ccSessionId, sessionID, env = process.env) {
  const path = sessionFile(ccSessionId, env)
  const record = (await readJson(path, null)) ?? {
    ccSessionId,
    registeredAt: Date.now(),
  }
  record.lastOpencodeSession = sessionID
  await writeJson(path, record)
}

export async function lastOpencodeSession(ccSessionId, env = process.env) {
  return (await readJson(sessionFile(ccSessionId, env), null))?.lastOpencodeSession ?? null
}

export async function pruneStale(env = process.env) {
  let ids
  try {
    ids = await readdir(jobsDir(env))
  } catch (error) {
    if (error.code === 'ENOENT') return { stale: [], removed: [] }
    throw error
  }

  const stale = []
  const removed = []
  const now = Date.now()
  for (const id of ids) {
    const job = await readJob(id, env)
    if (!job) continue

    if (job.state === 'running' && job.pid != null && !isAlive(job.pid)) {
      await updateJob(id, { state: 'stale', endedAt: now }, env)
      stale.push(id)
      continue
    }

    if (job.state !== 'running' && job.endedAt != null && now - job.endedAt > RETENTION_MS) {
      await rm(jobDir(id, env), { recursive: true, force: true })
      removed.push(id)
    }
  }
  return { stale, removed }
}
