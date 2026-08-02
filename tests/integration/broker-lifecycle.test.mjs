import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureBroker,
  addRef,
  releaseRef,
  reapOrphans,
  shutdownBroker,
} from '../../scripts/lib/broker-lifecycle.mjs'
import {
  readEndpoint,
  writeEndpoint,
  lockPath,
  refsPath,
} from '../../scripts/lib/broker-endpoint.mjs'
import { isAlive, spawnDetached, terminate } from '../../scripts/lib/process.mjs'
import { readJson, writeJson, sessionsDir } from '../../scripts/lib/state.mjs'

const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

const sandbox = async () => ({
  ...process.env,
  OPENCODE_BIN: fixture,
  XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'ocbl-')),
  HOME: '/nonexistent',
})

const bindFailure = (error) => /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(String(error?.message || error))

async function withBroker(t, env, callback) {
  let broker
  try {
    broker = await ensureBroker({ env })
    return await callback(broker)
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return undefined
    }
    throw error
  } finally {
    await shutdownBroker(env)
  }
}

async function registerSessions(env, ...ids) {
  await mkdir(sessionsDir(env), { recursive: true })
  for (const id of ids) await writeFile(join(sessionsDir(env), `${id}.json`), '{}')
}

test('ensureBroker starts a server and writes a live private portfile', async (t) => {
  const env = await sandbox()
  await withBroker(t, env, async (b) => {
    assert.match(b.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(await b.client.health(), true)
    const rec = await readEndpoint(env)
    assert.equal(rec.pid, b.pid)
    assert.ok(rec.password.length >= 16)
  })
})

test('a second ensureBroker reuses the same server', async (t) => {
  const env = await sandbox()
  await withBroker(t, env, async () => {
    const a = await ensureBroker({ env })
    const b = await ensureBroker({ env })
    assert.equal(a.baseUrl, b.baseUrl)
    assert.equal(a.pid, b.pid)
  })
})

test('concurrent ensureBroker calls spawn exactly one server', async (t) => {
  const env = await sandbox()
  await withBroker(t, env, async () => {
    const results = await Promise.all([
      ensureBroker({ env }),
      ensureBroker({ env }),
      ensureBroker({ env }),
    ])
    assert.equal(new Set(results.map((result) => result.pid)).size, 1)
  })
})

test('concurrent addRef calls preserve every distinct session', async () => {
  const env = await sandbox()
  const ids = Array.from({ length: 24 }, (_, index) => `cc-${index}`)
  const counts = await Promise.all(ids.map((id) => addRef(id, env)))
  assert.equal(Math.max(...counts), ids.length)
  assert.deepEqual(Object.keys(await readJson(refsPath(env), {})).sort(), ids.sort())
})

test('releaseRef prunes refs for sessions no longer registered', async () => {
  const env = await sandbox()
  await registerSessions(env, 'live', 'current')
  await writeJson(refsPath(env), { live: 1, current: 2, crashed: 3 })
  assert.deepEqual(await releaseRef('current', env), { remaining: 1, shutdown: false })
  assert.deepEqual(await readJson(refsPath(env), {}), { live: 1 })
})

test('reapOrphans does not remove a live broker lock', async () => {
  const env = await sandbox()
  const child = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  try {
    await writeEndpoint({ port: 1, pid: 2 ** 22, password: 'p', startedAt: 0 }, env)
    await mkdir(join(env.XDG_STATE_HOME, 'opencode-plugin-cc', 'broker'), { recursive: true })
    await writeFile(lockPath(env), JSON.stringify({ pid: child.pid, at: Date.now() }))
    assert.deepEqual(await reapOrphans(env), { cleared: false })
    assert.ok(await readEndpoint(env))
  } finally {
    await terminate(child.pid, { graceMs: 1000 })
    await shutdownBroker(env)
  }
})

test('reapOrphans clears a portfile whose pid is dead', async () => {
  const env = await sandbox()
  await writeEndpoint({ port: 1, pid: 2 ** 22, password: 'p', startedAt: 0 }, env)
  assert.deepEqual(await reapOrphans(env), { cleared: true })
  assert.equal(await readEndpoint(env), null)
})

test('the broker survives until the last ref is released', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-1', 'cc-2')
  await withBroker(t, env, async (b) => {
    await addRef('cc-1', env)
    await addRef('cc-2', env)
    assert.deepEqual(await releaseRef('cc-1', env), { remaining: 1, shutdown: false })
    assert.equal(isAlive(b.pid), true)
    const last = await releaseRef('cc-2', env)
    assert.equal(last.shutdown, true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(isAlive(b.pid), false)
  })
})

test('a server that will not bind fails with the server stderr', async () => {
  const env = { ...(await sandbox()), FAKE_OPENCODE_FAULT: 'port-bound' }
  try {
    await assert.rejects(() => ensureBroker({ env, timeoutMs: 5000 }), /EADDRINUSE|would not start/)
  } finally {
    await shutdownBroker(env)
  }
})

test('startup timeout terminates the detached child before clearing state', async () => {
  const env = await sandbox()
  const childPidFile = join(env.XDG_STATE_HOME, 'child.pid')
  env.OPENCODE_BROKER_CHILD_PID_FILE = childPidFile
  env.FAKE_OPENCODE_FAULT = 'slow-start'
  env.FAKE_OPENCODE_START_DELAY_MS = '1000'
  try {
    await assert.rejects(
      () => ensureBroker({ env, timeoutMs: 100 }),
      /timed out|would not start|never answered|EPERM/,
    )
    const childPid = Number(await readFile(childPidFile, 'utf8'))
    assert.ok(childPid > 0)
    assert.equal(isAlive(childPid), false)
    assert.equal(await readEndpoint(env), null)
  } finally {
    await shutdownBroker(env)
  }
})
