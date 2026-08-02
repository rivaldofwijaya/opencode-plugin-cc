import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDoctor, requireReady, CompanionError } from '../../scripts/lib/doctor.mjs'
import { readEndpoint } from '../../scripts/lib/broker-endpoint.mjs'
import { shutdownBroker } from '../../scripts/lib/broker-lifecycle.mjs'
import { clearBinaryCache } from '../../scripts/lib/opencode.mjs'

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

const bindFailure = (detail) => /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(String(detail))

test('a fully configured environment reports ok and cleans up its probe broker', async (t) => {
  clearBinaryCache()
  const s = await sandbox()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  const r = await runDoctor({ env: s.env, cwd: s.cwd })
  if (!r.server.ok && bindFailure(r.server.detail)) {
    t.skip(`loopback binding is unavailable in this sandbox: ${r.server.detail}`)
    await shutdownBroker(s.env)
    return
  }
  assert.equal(r.ok, true, JSON.stringify(r.gaps))
  assert.equal(r.binary.source, 'env')
  assert.equal(r.model.source, 'global')
  for (const key of ['binary', 'version', 'auth', 'model', 'server']) {
    assert.equal(typeof r[key].detail, 'string', `${key} detail`)
  }
  assert.equal(await readEndpoint(s.env), null)
  await shutdownBroker(s.env)
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
