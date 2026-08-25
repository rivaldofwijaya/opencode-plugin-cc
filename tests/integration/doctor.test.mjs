import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDoctor, requireReady, CompanionError } from '../../src/lib/doctor.mjs'
import { readEndpoint, refsPath } from '../../src/lib/broker-endpoint.mjs'
import { ensureBroker, addRef, releaseRef, shutdownBroker } from '../../src/lib/broker-lifecycle.mjs'
import { readJson, sessionsDir, writeJson } from '../../src/lib/state.mjs'
import { isAlive, terminate } from '../../src/lib/process.mjs'
import { clearBinaryCache } from '../../src/lib/opencode.mjs'
import { withFakeOwnedBroker } from '../helpers/process-cleanup.mjs'

const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocdoc-'))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  return { env, cwd: home }
}

async function configuredSandbox(extra = {}) {
  const s = await sandbox(extra)
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return s
}

const bindFailure = (detail) => /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(String(detail))

test('a fully configured environment reports ok and cleans up its probe broker', async (t) => {
  clearBinaryCache()
  const s = await configuredSandbox()
  const r = await runDoctor({ env: s.env, cwd: s.cwd })
  if (!r.server.ok && bindFailure(r.server.detail)) {
    t.skip(`loopback binding is unavailable in this sandbox: ${r.server.detail}`)
    await shutdownBroker(s.env)
    return
  }
  assert.equal(r.ok, true, JSON.stringify(r.gaps))
  assert.equal(r.binary.source, 'env')
  assert.equal(r.model.source, 'global')
  assert.deepEqual(r.server.broker.refcount, { remaining: 0, shutdown: true, released: true })
  assert.match(r.server.detail, /doctor released its broker reference and stopped the broker/)
  for (const key of ['binary', 'version', 'auth', 'model', 'server']) {
    assert.equal(typeof r[key].detail, 'string', `${key} detail`)
  }
  assert.equal(await readEndpoint(s.env), null)
  await shutdownBroker(s.env)
})

test('a failed broker probe leaves no endpoint behind', async () => {
  clearBinaryCache()
  const s = await sandbox({ FAKE_OPENCODE_FAULT: 'port-bound' })
  const r = await runDoctor({ env: s.env, cwd: s.cwd })
  assert.equal(r.server.ok, false)
  assert.match(r.server.detail, /would not start|EADDRINUSE/)
  assert.deepEqual(r.server.broker.refcount, { remaining: 0, shutdown: true, released: true })
  assert.equal(await readEndpoint(s.env), null)
})

test('doctor releases its reference but does not stop a broker held by another session', async (t) => {
  clearBinaryCache()
  const s = await configuredSandbox()
  await mkdir(sessionsDir(s.env), { recursive: true })
  await writeFile(join(sessionsDir(s.env), 'other-session.json'), '{}')
  await addRef('other-session', s.env, 'other-holder')
  let broker
  try {
    broker = await ensureBroker({ env: s.env })
  } catch (error) {
    if (bindFailure(error)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${error.message}`)
      await releaseRef('other-session', s.env, 'other-holder')
      return
    }
    throw error
  }

  try {
    const before = await readEndpoint(s.env)
    const r = await runDoctor({ env: s.env, cwd: s.cwd })
    if (!r.server.ok && bindFailure(r.server.detail)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${r.server.detail}`)
      return
    }
    const after = await readEndpoint(s.env)
    assert.equal(r.server.ok, true, JSON.stringify(r.gaps))
    assert.deepEqual(r.server.broker.refcount, { remaining: 1, shutdown: false, released: true })
    assert.match(r.server.detail, /broker remains running because 1 other session reference remains/)
    assert.equal(after.pid, before.pid)
    assert.equal(isAlive(before.pid), true)
  } finally {
    await releaseRef('other-session', s.env, 'other-holder')
    await shutdownBroker(s.env)
  }
})

test('a live doctor reference survives a concurrent release and is cleaned up on exit', async (t) => {
  clearBinaryCache()
  const s = await configuredSandbox()
  await mkdir(sessionsDir(s.env), { recursive: true })
  await writeFile(join(sessionsDir(s.env), 'other-session.json'), '{}')
  await addRef('other-session', s.env, 'other-holder')

  await withFakeOwnedBroker(t, s.env, async (broker) => {
    let concurrentResult
    let concurrentBrokerAlive
    const location = 'http://127.0.0.1:45678'
    const r = await runDoctor({
      env: s.env,
      cwd: s.cwd,
      inspectBrokerFn: async () => {
        concurrentResult = await releaseRef('other-session', s.env, 'other-holder')
        concurrentBrokerAlive = isAlive(broker.pid)
        return { state: 'running', baseUrl: location }
      },
      ensureBrokerFn: async () => ({ baseUrl: location }),
      listAgentsFn: async () => ['general'],
    })

    assert.equal(concurrentBrokerAlive, true, 'broker was stopped while the doctor reference was live')
    assert.deepEqual(concurrentResult, { remaining: 1, shutdown: false })
    assert.equal(r.ok, true, JSON.stringify(r.gaps))
    assert.deepEqual(r.server.broker.refcount, { remaining: 0, shutdown: true, released: true })
    assert.deepEqual(await readJson(refsPath(s.env), {}), {})
    assert.equal(await readEndpoint(s.env), null)
    assert.equal(isAlive(broker.pid), false)
  })
})

test('doctor uses plural wording for multiple remaining session references', async () => {
  clearBinaryCache()
  const s = await configuredSandbox()
  const location = 'http://127.0.0.1:45678'
  const r = await runDoctor({
    env: s.env,
    cwd: s.cwd,
    addRefFn: async () => {},
    inspectBrokerFn: async () => ({ state: 'running', baseUrl: location }),
    ensureBrokerFn: async () => ({ baseUrl: location }),
    releaseRefFn: async () => ({ remaining: 2, shutdown: false, released: true }),
    listAgentsFn: async () => ['general'],
  })

  assert.equal(r.server.ok, true, JSON.stringify(r.gaps))
  assert.equal(r.server.broker.shutdown, 'not attempted (2 other session references remain)')
  assert.match(r.server.detail, /broker remains running because 2 other session references remain/)
})

test('doctor reports a missing configured review agent and lists server agents', async () => {
  clearBinaryCache()
  const s = await configuredSandbox()
  const r = await runDoctor({
    env: s.env,
    cwd: s.cwd,
    addRefFn: async () => {},
    inspectBrokerFn: async () => ({ state: 'running', baseUrl: 'http://127.0.0.1:45678' }),
    ensureBrokerFn: async () => ({ baseUrl: 'http://127.0.0.1:45678' }),
    listAgentsFn: async () => ['build', 'explore', 'plan'],
    releaseRefFn: async () => ({ remaining: 0, shutdown: true, released: true }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.server.ok, false)
  assert.deepEqual(r.server.reviewAgent, {
    configured: 'general',
    available: ['build', 'explore', 'plan'],
    ok: false,
    detail: 'general is absent; available agents: build, explore, plan',
  })
  assert.match(r.gaps.join('\n'), /configured review agent general.*available agents: build, explore, plan/)
})

test('doctor rejects malformed broker release results and names the broker location', async () => {
  clearBinaryCache()
  const s = await configuredSandbox()
  const location = 'http://127.0.0.1:45678'
  const malformed = [
    { remaining: 0, shutdown: false },
    { released: 'yes', remaining: 0, shutdown: false },
    { released: true, remaining: -1, shutdown: false },
    { released: true, remaining: 0, shutdown: 'no' },
  ]

  for (const outcome of malformed) {
    const r = await runDoctor({
      env: s.env,
      cwd: s.cwd,
      addRefFn: async () => {},
      inspectBrokerFn: async () => ({ state: 'absent' }),
      ensureBrokerFn: async () => ({ baseUrl: location }),
      releaseRefFn: async () => outcome,
      listAgentsFn: async () => ['general'],
    })
    assert.equal(r.ok, false, JSON.stringify(outcome))
    assert.equal(r.server.ok, false, JSON.stringify(outcome))
    assert.equal(r.server.broker.shutdown.ok, false, JSON.stringify(outcome))
    assert.match(r.gaps.at(-1), /invalid result at http:\/\/127\.0\.0\.1:45678/)
  }
})

test('doctor stops the broker when its reference is the only holder', async () => {
  clearBinaryCache()
  const s = await configuredSandbox()
  const calls = []
  const location = 'http://127.0.0.1:45678'
  const r = await runDoctor({
    env: s.env,
    cwd: s.cwd,
    addRefFn: async (identity) => { calls.push(['add', identity]) },
    inspectBrokerFn: async () => ({ state: 'absent' }),
    ensureBrokerFn: async () => ({ baseUrl: location }),
    listAgentsFn: async () => ['general'],
    releaseRefFn: async (identity) => {
      calls.push(['release', identity])
      return { remaining: 0, shutdown: true, released: true }
    },
  })
  assert.equal(r.server.ok, true, JSON.stringify(r.gaps))
  assert.deepEqual(r.server.broker.refcount, { remaining: 0, shutdown: true, released: true })
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'add')
  assert.deepEqual(calls[1], ['release', calls[0][1]])
  assert.match(r.server.detail, /stopped the broker/)
})

test('doctor releases its reference when the broker probe fails', async () => {
  clearBinaryCache()
  const s = await configuredSandbox()
  let released = false
  const r = await runDoctor({
    env: s.env,
    cwd: s.cwd,
    addRefFn: async () => {},
    inspectBrokerFn: async () => ({ state: 'absent' }),
    ensureBrokerFn: async () => { throw new Error('probe failed') },
    releaseRefFn: async () => {
      released = true
      return { remaining: 0, shutdown: true, released: true }
    },
  })
  assert.equal(released, true)
  assert.equal(r.server.ok, false)
  assert.deepEqual(r.server.broker.refcount, { remaining: 0, shutdown: true, released: true })
})

test('doctor releases its reference when an exception is thrown mid-check', async () => {
  clearBinaryCache()
  const s = await configuredSandbox()
  let released = false
  const r = await runDoctor({
    env: s.env,
    cwd: s.cwd,
    addRefFn: async () => {},
    inspectBrokerFn: async () => { throw new Error('inspection exploded') },
    releaseRefFn: async () => {
      released = true
      return { remaining: 0, shutdown: true, released: true }
    },
  })
  assert.equal(released, true)
  assert.equal(r.server.ok, false)
  assert.match(r.server.detail, /inspection exploded/)
  assert.match(r.server.detail, /re-inspect|stopped the broker/)
})

test('a failed release is reported with the broker location', async () => {
  clearBinaryCache()
  const s = await configuredSandbox()
  const location = 'http://127.0.0.1:45678'
  const r = await runDoctor({
    env: s.env,
    cwd: s.cwd,
    addRefFn: async () => {},
    inspectBrokerFn: async () => ({ state: 'absent' }),
    ensureBrokerFn: async () => ({ baseUrl: location }),
    releaseRefFn: async () => {
      throw new Error('timed out waiting for the opencode broker lock')
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.server.ok, false)
  assert.match(r.server.detail, /could not release doctor's broker reference/)
  assert.match(r.server.detail, /may still be running/)
  assert.match(r.server.detail, new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(r.server.broker.shutdown.ok, false)
})

test('an unexpected pre-server helper exception still returns a report', async () => {
  clearBinaryCache()
  const s = await sandbox()
  const r = await runDoctor({
    env: s.env,
    cwd: s.cwd,
    listProvidersFn: async () => { throw new Error('credentials could not be read') },
  })
  assert.equal(typeof r, 'object')
  assert.equal(r.ok, false)
  assert.match(r.auth.detail, /credentials could not be read/)
  assert.equal(r.server.detail, 'not checked')
})

test('a missing binary short-circuits every later check', async () => {
  clearBinaryCache()
  const s = await sandbox({ OPENCODE_BIN: '/nonexistent/opencode', PATH: '/nonexistent' })
  const r = await runDoctor({ env: s.env, cwd: s.cwd })
  assert.equal(r.binary.ok, false)
  for (const key of ['version', 'auth', 'model', 'server']) {
    assert.equal(r[key].ok, false)
    assert.equal(r[key].detail, 'not checked')
  }
  assert.match(r.gaps[0], /binary/i)
})

test('an out-of-date binary is a version gap, not a binary gap', async () => {
  clearBinaryCache()
  const s = await sandbox({ FAKE_OPENCODE_FAULT: 'old-version' })
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.binary.ok, true)
  assert.equal(r.version.ok, false)
  assert.equal(r.version.value, '1.17.0')
  assert.match(r.gaps.join(' '), /1\.18\.0/)
})

test('no auth.json is an auth gap and env hints are surfaced', async () => {
  clearBinaryCache()
  const s = await sandbox({ ANTHROPIC_API_KEY: 'sk-test' })
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.auth.ok, false)
  assert.deepEqual(r.auth.envHints.map(h => h.provider), ['anthropic'])
})

test('auth present but no model is exactly one gap', async () => {
  clearBinaryCache()
  const s = await sandbox()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.auth.ok, true)
  assert.equal(r.model.ok, false)
  assert.equal(r.gaps.length, 1)
  assert.match(r.gaps[0], /model/i)
})

test('a project opencode.json beats the global config in the report', async () => {
  clearBinaryCache()
  const s = await sandbox()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"global/m"}')
  await writeFile(join(s.cwd, 'opencode.json'), '{"model":"project/m"}')
  const r = await runDoctor({ env: s.env, cwd: s.cwd, checkServer: false })
  assert.equal(r.model.value, 'project/m')
  assert.equal(r.model.source, 'project')
})

test('requireReady throws a CompanionError naming the gap', () => {
  const report = { ok: false, gaps: ['no default model is configured'], binary: { ok: true }, version: { ok: true }, auth: { ok: true }, model: { ok: false }, server: { ok: true } }
  assert.throws(() => requireReady(report), (e) => e instanceof CompanionError && /no default model/.test(e.message) && /\/opencode:setup/.test(e.message))
})

test('requireReady passes when the needed checks are ok', () => {
  const report = { ok: false, gaps: ['server unreachable'], binary: { ok: true }, version: { ok: true }, auth: { ok: true }, model: { ok: true }, server: { ok: false } }
  requireReady(report, { need: ['binary', 'version', 'auth', 'model'] })
})
