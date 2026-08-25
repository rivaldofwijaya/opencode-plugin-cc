import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureBroker,
  addRef,
  addSessionRef,
  releaseRef,
  reapOrphans,
  SESSION_HOLDER_MAX_AGE_MS,
  shutdownBroker,
} from '../../../src/lib/broker-lifecycle.mjs'
import {
  readEndpoint,
  writeEndpoint,
  lockPath,
  refsPath,
} from '../../../src/lib/broker-endpoint.mjs'
import { isAlive, terminate } from '../../../src/lib/process.mjs'
import { spawnTracked, withFakeOwnedBroker } from '../helpers/process-cleanup.mjs'
import { brokerDir, readJson, writeJson, sessionsDir } from '../../../src/lib/state.mjs'

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

async function waitForChildPid(path, startup) {
  const startupSettled = startup.then(
    () => true,
    () => true,
  )
  while (true) {
    try {
      const pid = Number(await readFile(path, 'utf8'))
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const settled = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve(false), 10)),
      startupSettled,
    ])
    if (settled) throw new Error('broker startup settled before its child PID was recorded')
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

test('two holders in one session keep the broker alive until both release', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-shared')
  await withFakeOwnedBroker(t, env, async (broker) => {
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

test('tokenless release does not steal a live holder owned by another pid', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-two-live')
  await withFakeOwnedBroker(t, env, async (broker) => {
    const first = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const second = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
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

test('tokenless release can release the sole migrated legacy holder', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-legacy-only')
  await withFakeOwnedBroker(t, env, async (broker) => {
    await writeJson(refsPath(env), { 'cc-legacy-only': Date.now() })

    const result = await releaseRef('cc-legacy-only', env)
    assert.deepEqual(result, { remaining: 0, shutdown: true, released: true })
    assert.deepEqual(await readJson(refsPath(env), {}), {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(isAlive(broker.pid), false)
  })
})

test('tokenless release prefers this process holder over another live pid', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-owned')
  await withFakeOwnedBroker(t, env, async (broker) => {
    const foreign = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
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

test('dead holders are pruned before they can pin the broker', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-dead', 'cc-live')
  await withFakeOwnedBroker(t, env, async (broker) => {
    const dead = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
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

test('an explicit no-op release shuts down after pruning the last dead holder', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-dead-explicit')
  await withFakeOwnedBroker(t, env, async (broker) => {
    const dead = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await terminate(dead.pid, { graceMs: 1000 })
    await writeJson(refsPath(env), {
      'cc-dead-explicit': {
        'dead-holder': { pid: dead.pid, at: Date.now() },
      },
    })

    const result = await releaseRef('cc-dead-explicit', env, 'missing-holder')
    assert.equal(isAlive(broker.pid), false)
    assert.deepEqual(result, { released: false, remaining: 0, shutdown: true })
  })
})

test('a tokenless no-op release shuts down after pruning the last dead holder', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-dead-tokenless')
  await withFakeOwnedBroker(t, env, async (broker) => {
    const dead = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await terminate(dead.pid, { graceMs: 1000 })
    await writeJson(refsPath(env), {
      'cc-dead-tokenless': {
        'dead-holder': { pid: dead.pid, at: Date.now() },
      },
    })

    const result = await releaseRef('cc-dead-tokenless', env)
    assert.equal(isAlive(broker.pid), false)
    assert.deepEqual(result, { released: false, remaining: 0, shutdown: true })
  })
})

test('a no-op release leaves another live holder and the broker untouched', async (t) => {
  const env = await sandbox()
  await registerSessions(env, 'cc-dead-with-live', 'cc-live-with-dead')
  await withFakeOwnedBroker(t, env, async (broker) => {
    const dead = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    const live = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await terminate(dead.pid, { graceMs: 1000 })
    const liveAt = Date.now() + 1
    try {
      await writeJson(refsPath(env), {
        'cc-dead-with-live': {
          'dead-holder': { pid: dead.pid, at: Date.now() },
        },
        'cc-live-with-dead': {
          'live-holder': { pid: live.pid, at: liveAt },
        },
      })

      const result = await releaseRef('cc-dead-with-live', env, 'missing-holder')
      assert.deepEqual(result, { released: false, remaining: 1, shutdown: false })
      const refs = await readJson(refsPath(env), {})
      assert.equal(refs['cc-dead-with-live'], undefined)
      assert.deepEqual(refs['cc-live-with-dead'], {
        'live-holder': { pid: live.pid, at: liveAt },
      })
      assert.equal(isAlive(live.pid), true)
      assert.equal(isAlive(broker.pid), true)
    } finally {
      if (isAlive(live.pid)) await terminate(live.pid, { graceMs: 1000 })
    }
  })
})

test('repair never prunes a live non-session holder', async (t) => {
  const env = await sandbox()
  const live = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const at = Date.now()
  try {
    await writeJson(refsPath(env), {
      'cc-live-holder': { 'live-holder': { pid: live.pid, at } },
    })

    assert.deepEqual(await reapOrphans(env), { cleared: false })
    assert.deepEqual(await readJson(refsPath(env), {}), {
      'cc-live-holder': { 'live-holder': { pid: live.pid, at } },
    })
    assert.equal(isAlive(live.pid), true)
  } finally {
    if (isAlive(live.pid)) await terminate(live.pid, { graceMs: 1000 })
  }
})

test('repair reclaims a session holder pinned to a live unrelated process', async (t) => {
  const env = await sandbox()
  const unrelated = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  try {
    await writeJson(refsPath(env), {
      'cc-crashed': {
        'session-holder': {
          pid: process.pid,
          at: Date.now(),
          scope: 'session',
          sessionPid: unrelated.pid,
          expiresAt: Date.now() + SESSION_HOLDER_MAX_AGE_MS,
        },
      },
    })

    assert.deepEqual(await reapOrphans(env), { cleared: true })
    assert.deepEqual(await readJson(refsPath(env), {}), {})
    assert.equal(isAlive(unrelated.pid), true)
  } finally {
    if (isAlive(unrelated.pid)) await terminate(unrelated.pid, { graceMs: 1000 })
  }
})

test('repair reclaims an expired session holder without PID evidence', async () => {
  const env = await sandbox()
  const expiredAt = Date.now() - 1
  await writeJson(refsPath(env), {
    'cc-expired': {
      'session-holder': {
        pid: null,
        at: expiredAt - SESSION_HOLDER_MAX_AGE_MS,
        scope: 'session',
        sessionPid: null,
        expiresAt: expiredAt,
      },
    },
  })

  assert.deepEqual(await reapOrphans(env), { cleared: true })
  assert.deepEqual(await readJson(refsPath(env), {}), {})
})

test('repair reclaims an expired migrated legacy holder', async () => {
  const env = await sandbox()
  await writeJson(refsPath(env), {
    'cc-legacy-expired': Date.now() - SESSION_HOLDER_MAX_AGE_MS - 1,
  })

  assert.deepEqual(await reapOrphans(env), { cleared: true })
  assert.deepEqual(await readJson(refsPath(env), {}), {})
})

test('session refs reject an unrelated configured PID and receive an expiry', async (t) => {
  const env = await sandbox()
  const unrelated = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  try {
    env.CLAUDE_CODE_SESSION_PID = String(unrelated.pid)
    await addSessionRef('cc-identity', env, 'session:cc-identity')
    const holder = (await readJson(refsPath(env), {}))['cc-identity']['session:cc-identity']
    assert.equal(holder.scope, 'session')
    assert.notEqual(holder.sessionPid, unrelated.pid)
    assert.equal(holder.expiresAt, holder.at + SESSION_HOLDER_MAX_AGE_MS)
  } finally {
    if (isAlive(unrelated.pid)) await terminate(unrelated.pid, { graceMs: 1000 })
  }
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

test('reapOrphans does not remove a live broker lock', async (t) => {
  const env = await sandbox()
  const child = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
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

test('reapOrphans never signals a live unrelated process in a recycled-pid record', async (t) => {
  const env = await sandbox()
  const stranger = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const password = 'test-password'
  const startedAt = Date.now()
  try {
    await writeEndpoint({ port: 1, pid: stranger.pid, password, startedAt }, env)
    await writeJson(join(brokerDir(env), 'owner.json'), {
      pid: stranger.pid,
      port: 1,
      startedAt,
      passwordHash: createHash('sha256').update(password).digest('hex'),
    })

    assert.deepEqual(await reapOrphans(env), {
      cleared: false,
      protected: true,
      detail: 'broker process identity could not be proven; records remain for repair',
    })
    assert.equal(isAlive(stranger.pid), true)
    assert.equal((await readEndpoint(env)).pid, stranger.pid)
    await terminate(stranger.pid, { graceMs: 1000 })
    assert.deepEqual(await reapOrphans(env), { cleared: true })
    assert.equal(await readEndpoint(env), null)
  } finally {
    if (isAlive(stranger.pid)) await terminate(stranger.pid, { graceMs: 1000 })
    await shutdownBroker(env)
  }
})

test('reapOrphans refuses a matching command with a mismatched process start time', async (t) => {
  const env = await sandbox()
  await withFakeOwnedBroker(t, env, async ({ startedAt }) => {
    const stranger = spawnTracked(t, process.execPath, [
      '-e', 'setInterval(() => {}, 1000)',
      'serve', '--port', '0', '--hostname', '127.0.0.1',
    ])
    const endpoint = await readEndpoint(env)
    const mismatchedStartedAt = startedAt - 60_000
    await writeEndpoint({ ...endpoint, pid: stranger.pid, startedAt: mismatchedStartedAt }, env)
    await writeJson(join(brokerDir(env), 'owner.json'), {
      pid: stranger.pid,
      port: endpoint.port,
      startedAt: mismatchedStartedAt,
      passwordHash: createHash('sha256').update(endpoint.password).digest('hex'),
    })

    assert.deepEqual(await reapOrphans(env), {
      cleared: false,
      protected: true,
      detail: 'broker process identity could not be proven; records remain for repair',
    })
    assert.equal(isAlive(stranger.pid), true)
    assert.equal((await readEndpoint(env)).pid, stranger.pid)

    await terminate(stranger.pid, { graceMs: 1000 })
    assert.deepEqual(await reapOrphans(env), { cleared: true })
    assert.equal(await readEndpoint(env), null)
  })
})

test('reapOrphans repairs stale refs and stops a broker held only by them', async (t) => {
  const env = await sandbox()
  await withFakeOwnedBroker(t, env, async (broker) => {
    const dead = spawnTracked(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    await terminate(dead.pid, { graceMs: 1000 })
    await writeJson(refsPath(env), {
      'cc-stale': { 'dead-holder': { pid: dead.pid, at: Date.now() } },
    })

    assert.deepEqual(await reapOrphans(env), { cleared: true })
    assert.deepEqual(await readJson(refsPath(env), {}), {})
    assert.equal(await readEndpoint(env), null)
    assert.equal(isAlive(broker.pid), false)
  })
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
  env.FAKE_OPENCODE_START_DELAY_MS = '10000'
  const startup = ensureBroker({ env, timeoutMs: 1000 })
  let childPid
  try {
    childPid = await waitForChildPid(childPidFile, startup)
    await assert.rejects(startup, /timed out|would not start|never answered|EPERM/)
    assert.equal(isAlive(childPid), false)
    assert.equal(await readEndpoint(env), null)
  } finally {
    await startup.catch(() => {})
    if (childPid && isAlive(childPid)) await terminate(childPid, { graceMs: 1000 })
    await shutdownBroker(env)
  }
})

test('startup health failure preserves records when broker identity is unavailable', async (t) => {
  const env = await sandbox()
  const psDir = join(env.XDG_STATE_HOME, 'ps-bin')
  const originalPath = env.PATH
  await mkdir(psDir, { recursive: true, mode: 0o700 })
  await writeFile(join(psDir, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  await chmod(join(psDir, 'ps'), 0o700)
  env.PATH = `${psDir}:${originalPath || ''}`
  env.FAKE_OPENCODE_FAULT = 'no-health'

  try {
    let error
    try {
      await ensureBroker({ env, timeoutMs: 1000 })
    } catch (caught) {
      error = caught
    }
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      return
    }
    assert.ok(error)
    assert.match(error.message, /records remain for repair/)
    assert.match(error.message, /run \/opencode:repair again/)
    const endpoint = await readEndpoint(env)
    assert.ok(endpoint)
    assert.ok(await readJson(join(brokerDir(env), 'owner.json'), null))
    assert.equal(isAlive(endpoint.pid), true)
  } finally {
    env.PATH = originalPath
    await shutdownBroker(env).catch(() => {})
  }
})
