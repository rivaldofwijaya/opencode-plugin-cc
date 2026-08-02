import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { brokerDir, readJson, writeJson, sessionsDir } from '../../scripts/lib/state.mjs'

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

async function withFakeOwnedBroker(env, callback) {
  const child = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const password = 'test-password'
  const startedAt = Date.now()
  await writeEndpoint({ port: 1, pid: child.pid, password, startedAt }, env)
  await writeJson(join(brokerDir(env), 'owner.json'), {
    pid: child.pid,
    port: 1,
    startedAt,
    passwordHash: createHash('sha256').update(password).digest('hex'),
  })
  try {
    return await callback({ pid: child.pid })
  } finally {
    await shutdownBroker(env)
    if (isAlive(child.pid)) await terminate(child.pid, { graceMs: 1000 })
  }
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
  const counts = await Promise.all(ids.map((id, index) => addRef(id, env, `holder-${index}`)))
  assert.equal(Math.max(...counts), ids.length)
  const refs = await readJson(refsPath(env), {})
  assert.deepEqual(Object.keys(refs).sort(), ids.sort())
  for (const id of ids) assert.equal(Object.keys(refs[id]).length, 1)
})

test('releaseRef prunes refs for sessions no longer registered', async () => {
  const env = await sandbox()
  await registerSessions(env, 'live', 'current')
  await writeJson(refsPath(env), { live: 1, current: 2, crashed: 3 })
  assert.deepEqual(await releaseRef('current', env), { remaining: 1, shutdown: false, released: true })
  const refs = await readJson(refsPath(env), {})
  assert.deepEqual(Object.keys(refs), ['live'])
  assert.deepEqual(Object.values(refs.live), [{ pid: null, at: 1 }])
})

test('two holders in one session keep the broker alive until both release', async () => {
  const env = await sandbox()
  await registerSessions(env, 'cc-shared')
  await withFakeOwnedBroker(env, async (broker) => {
    await addRef('cc-shared', env, 'holder-first')
    await addRef('cc-shared', env, 'holder-second')

    const first = await releaseRef('cc-shared', env, 'holder-first')
    assert.equal(isAlive(broker.pid), true)
    assert.deepEqual(first, { remaining: 1, shutdown: false })

    const second = await releaseRef('cc-shared', env, 'holder-second')
    assert.deepEqual(second, { remaining: 0, shutdown: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(isAlive(broker.pid), false)
  })
})

test('tokenless release does not steal a live holder owned by another pid', async () => {
  const env = await sandbox()
  await registerSessions(env, 'cc-two-live')
  await withFakeOwnedBroker(env, async (broker) => {
    const first = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const second = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    try {
      await writeJson(refsPath(env), {
        'cc-two-live': {
          'holder-first': { pid: first.pid, at: Date.now() },
          'holder-second': { pid: second.pid, at: Date.now() + 1 },
        },
      })

      const result = await releaseRef('cc-two-live', env)
      assert.deepEqual(result, { remaining: 2, shutdown: false, released: false })
      const refs = await readJson(refsPath(env), {})
      assert.deepEqual(Object.keys(refs['cc-two-live']).sort(), ['holder-first', 'holder-second'])
      assert.equal(isAlive(broker.pid), true)
    } finally {
      if (isAlive(first.pid)) await terminate(first.pid, { graceMs: 1000 })
      if (isAlive(second.pid)) await terminate(second.pid, { graceMs: 1000 })
    }
  })
})

test('tokenless release can release the sole migrated legacy holder', async () => {
  const env = await sandbox()
  await registerSessions(env, 'cc-legacy-only')
  await withFakeOwnedBroker(env, async (broker) => {
    await writeJson(refsPath(env), { 'cc-legacy-only': Date.now() })

    const result = await releaseRef('cc-legacy-only', env)
    assert.deepEqual(result, { remaining: 0, shutdown: true, released: true })
    assert.deepEqual(await readJson(refsPath(env), {}), {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(isAlive(broker.pid), false)
  })
})

test('tokenless release prefers this process holder over another live pid', async () => {
  const env = await sandbox()
  await registerSessions(env, 'cc-owned')
  await withFakeOwnedBroker(env, async (broker) => {
    const foreign = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    try {
      await writeJson(refsPath(env), {
        'cc-owned': {
          'this-process': { pid: process.pid, at: Date.now() },
          'foreign-process': { pid: foreign.pid, at: Date.now() + 1 },
        },
      })

      const result = await releaseRef('cc-owned', env)
      assert.deepEqual(result, { remaining: 1, shutdown: false, released: true })
      const refs = await readJson(refsPath(env), {})
      assert.deepEqual(Object.keys(refs['cc-owned']), ['foreign-process'])
      assert.equal(isAlive(foreign.pid), true)
      assert.equal(isAlive(broker.pid), true)
    } finally {
      if (isAlive(foreign.pid)) await terminate(foreign.pid, { graceMs: 1000 })
    }
  })
})

test('dead holders are pruned before they can pin the broker', async () => {
  const env = await sandbox()
  await registerSessions(env, 'cc-dead', 'cc-live')
  await withFakeOwnedBroker(env, async (broker) => {
    const dead = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await terminate(dead.pid, { graceMs: 1000 })
    assert.equal(isAlive(dead.pid), false)
    await writeJson(refsPath(env), {
      'cc-dead': { 'dead-holder': { pid: dead.pid, at: Date.now() } },
    })

    assert.equal(await addRef('cc-live', env, 'live-holder'), 1)
    const refs = await readJson(refsPath(env), {})
    assert.equal(refs['cc-dead'], undefined)

    assert.deepEqual(
      await releaseRef('cc-live', env, 'live-holder'),
      { remaining: 0, shutdown: true },
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(isAlive(broker.pid), false)
  })
})

test('old session timestamps migrate to independent holders without throwing', async () => {
  const env = await sandbox()
  await writeJson(refsPath(env), { legacy: 1 })

  assert.equal(await addRef('legacy', env, 'new-holder'), 2)
  const refs = await readJson(refsPath(env), {})
  assert.equal(typeof refs.legacy, 'object')
  assert.equal(Object.keys(refs.legacy).length, 2)
  assert.deepEqual(refs.legacy['new-holder'], { pid: process.pid, at: refs.legacy['new-holder'].at })
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
    await addRef('cc-1', env, 'holder-1')
    await addRef('cc-2', env, 'holder-2')
    assert.deepEqual(await releaseRef('cc-1', env, 'holder-1'), { remaining: 1, shutdown: false })
    assert.equal(isAlive(b.pid), true)
    const last = await releaseRef('cc-2', env, 'holder-2')
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
