import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  endpointPath,
  lockPath,
  refsPath,
  readEndpoint,
  writeEndpoint,
  clearEndpoint,
  baseUrlFor,
  acquireLock,
  releaseLock,
} from '../../scripts/lib/broker-endpoint.mjs'

const sandbox = async () => ({
  XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocbroker-')),
  HOME: '/nonexistent',
})

test('paths live under the broker state dir', async () => {
  const env = { XDG_STATE_HOME: '/s' }
  assert.equal(endpointPath(env), '/s/opencode-plugin-cc/broker/port.json')
  assert.equal(lockPath(env), '/s/opencode-plugin-cc/broker/lock')
  assert.equal(refsPath(env), '/s/opencode-plugin-cc/broker/refs.json')
})

test('readEndpoint returns null before anything is written', async () => {
  assert.equal(await readEndpoint(await sandbox()), null)
})

test('writeEndpoint then readEndpoint round-trips and baseUrlFor is loopback', async () => {
  const env = await sandbox()
  await writeEndpoint({ port: 4096, pid: 999, password: 'pw', startedAt: 1 }, env)
  const rec = await readEndpoint(env)
  assert.equal(rec.port, 4096)
  assert.equal(baseUrlFor(rec), 'http://127.0.0.1:4096')
  assert.equal((await stat(endpointPath(env))).mode & 0o777, 0o600)
})

test('clearEndpoint removes the portfile and is safe twice', async () => {
  const env = await sandbox()
  await writeEndpoint({ port: 1, pid: 2, password: 'p', startedAt: 0 }, env)
  await clearEndpoint(env)
  await clearEndpoint(env)
  assert.equal(await readEndpoint(env), null)
})

test('clearEndpoint does not unlink the lock held by its caller', async () => {
  const env = await sandbox()
  await writeEndpoint({ port: 1, pid: 2, password: 'p', startedAt: 0 }, env)
  assert.equal(await acquireLock(env), true)
  await clearEndpoint(env)
  assert.equal(await readEndpoint(env), null)
  assert.equal(await acquireLock(env), false)
  await releaseLock(env)
  assert.equal(await acquireLock(env), true)
  await releaseLock(env)
})

test('clearEndpoint rethrows cleanup errors other than ENOENT', async () => {
  const env = await sandbox()
  await mkdir(endpointPath(env), { recursive: true })
  try {
    await assert.rejects(clearEndpoint(env), (error) => ['EISDIR', 'EPERM'].includes(error.code))
  } finally {
    await rmdir(endpointPath(env))
  }
})

test('acquireLock is exclusive and releaseLock frees it', async () => {
  const env = await sandbox()
  assert.equal(await acquireLock(env), true)
  assert.equal(await acquireLock(env), false)
  await releaseLock(env)
  assert.equal(await acquireLock(env), true)
})

test('a lock held by a dead pid is treated as stale', async () => {
  const env = await sandbox()
  await mkdir(join(env.XDG_STATE_HOME, 'opencode-plugin-cc', 'broker'), { recursive: true })
  await writeFile(lockPath(env), JSON.stringify({ pid: 2 ** 22, at: Date.now() }))
  assert.equal(await acquireLock(env), true)
})

test('a freshly created partial lock is not treated as stale', async () => {
  const env = await sandbox()
  await mkdir(join(env.XDG_STATE_HOME, 'opencode-plugin-cc', 'broker'), { recursive: true })
  await writeFile(lockPath(env), '')
  assert.equal(await acquireLock(env), false)
  await releaseLock(env)
})
