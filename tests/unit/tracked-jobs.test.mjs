import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  newJobId, createJob, readJob, updateJob, listJobs, appendEvent, readEvents,
  writeResult, readResult, registerSession, knownSessions, unregisterSession,
  rememberOpencodeSession, lastOpencodeSession, pruneStale,
} from '../../src/lib/tracked-jobs.mjs'

const sandbox = async () => ({
  XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocjobs-')),
  HOME: '/nonexistent',
})

test('newJobId is unique and prefixed', () => {
  const a = newJobId()
  const b = newJobId()
  assert.match(a, /^job_[0-9a-z]+[0-9a-f]{6}$/)
  assert.notEqual(a, b)
})

test('createJob writes a foreground record with zeroed counters', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/repo' }, env)
  assert.equal(job.state, 'running')
  assert.equal(job.pid, process.pid)
  assert.deepEqual(job.counters, { steps: 0, tools: 0, inputTokens: 0, outputTokens: 0 })
  assert.deepEqual(await readJob(job.id, env), job)
})

test('createJob can leave ownership unset for a background worker', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/repo', background: true }, env)
  assert.equal(job.pid, null)
  assert.equal((await pruneStale(env)).stale.length, 0)
})

test('updateJob shallow-merges', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  const next = await updateJob(job.id, { state: 'done', sessionID: 'ses_1' }, env)
  assert.equal(next.state, 'done')
  assert.equal(next.verb, 'review')
})

test('listJobs is scoped to one Claude Code session, newest first', async () => {
  const env = await sandbox()
  const a = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const b = await createJob({ ccSessionId: 'cc-1', verb: 'task', cwd: '/r' }, env)
  await createJob({ ccSessionId: 'cc-2', verb: 'task', cwd: '/r' }, env)
  const mine = await listJobs('cc-1', env)
  assert.deepEqual(mine.map((job) => job.id), [b.id, a.id])
})

test('events and result round-trip', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await appendEvent(job.id, { type: 'session.idle' }, env)
  assert.deepEqual(await readEvents(job.id, env), [{ type: 'session.idle' }])
  await writeResult(job.id, '# findings', env)
  assert.equal(await readResult(job.id, env), '# findings')
  assert.equal(await readResult('job_missing', env), null)
})

test('session registration and opencode session memory', async () => {
  const env = await sandbox()
  await registerSession('cc-1', env)
  assert.deepEqual(await knownSessions(env), ['cc-1'])
  assert.equal(await lastOpencodeSession('cc-1', env), null)
  await rememberOpencodeSession('cc-1', 'ses_abc', env)
  assert.equal(await lastOpencodeSession('cc-1', env), 'ses_abc')
  await unregisterSession('cc-1', env)
  assert.deepEqual(await knownSessions(env), [])
})

test('pruneStale marks a running job with a dead owner pid as stale', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await updateJob(job.id, { pid: 2 ** 22 }, env)
  const result = await pruneStale(env)
  assert.deepEqual(result.stale, [job.id])
  assert.equal((await readJob(job.id, env)).state, 'stale')
})

test('pruneStale leaves a finished job alone', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await updateJob(job.id, { state: 'done', endedAt: Date.now() }, env)
  assert.deepEqual((await pruneStale(env)).stale, [])
  assert.equal((await readJob(job.id, env)).state, 'done')
})

test('pruneStale removes finished jobs older than the retention window', async () => {
  const env = await sandbox()
  const job = await createJob({ ccSessionId: 'cc-1', verb: 'review', cwd: '/r' }, env)
  await updateJob(job.id, { state: 'failed', endedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }, env)
  assert.deepEqual((await pruneStale(env)).removed, [job.id])
  assert.equal(await readJob(job.id, env), null)
})
