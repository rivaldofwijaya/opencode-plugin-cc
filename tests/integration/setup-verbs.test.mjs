import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'
import { handlers } from '../../scripts/opencode-companion.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocsetup-'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-setup',
    ...extra,
  }
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  return { env, home }
}

const cli = (env, args, cwd) => run(process.execPath, [companion, ...args], { env, cwd })

test('set-key writes auth.json at 0600 and prints only a redacted confirmation', async () => {
  const s = await sandbox()
  const rawKey = 'sk-or-abcd1234'
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', rawKey])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\*\*\*\*1234/)
  assert.equal(r.stdout.includes(rawKey), false)
  assert.equal(r.stderr.includes(rawKey), false)
  const p = join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  assert.equal(JSON.parse(await readFile(p, 'utf8')).openrouter.key, 'sk-or-abcd1234')
  assert.equal((await stat(p)).mode & 0o777, 0o600)
})

test('set-key preserves an existing provider', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"anthropic":{"type":"api","key":"KEEP"}}')
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-wxyz9876'])
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'))
  assert.equal(out.anthropic.key, 'KEEP')
  assert.deepEqual(out.openrouter, { type: 'api', key: 'sk-or-wxyz9876' })
  assert.match(r.stdout, /Backed up the previous file to .*auth\.json\.bak\./)
})

test('set-key without a key reports invalid invocation with a clear message', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter'])
  assert.equal(r.code, 2)
  assert.equal(r.stderr.trim(), 'set-key requires --key <API_KEY>')
  assert.equal(r.stdout, '')
})

test('set-key reports a sanitized underlying filesystem error code', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'))
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-neverprint'])
  assert.equal(r.code, 1)
  assert.equal(r.stderr.trim(), 'set-key failed (EISDIR)')
  assert.equal(r.stderr.includes('sk-or-neverprint'), false)
})

test('set-model merges into the existing global .jsonc, reports comments dropped, and re-runs doctor', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  const cfg = join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc')
  await writeFile(cfg, '{\n  // keep\n  "theme": "dark"\n}')
  const r = await cli(s.env, ['set-model', '--model', 'openrouter/x'])
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(cfg, 'utf8'))
  assert.equal(out.theme, 'dark')
  assert.equal(out.model, 'openrouter/x')
  assert.match(r.stdout, /Backed up the previous file to .*opencode\.jsonc\.bak\./)
  assert.match(r.stdout, /comments were dropped/i)
  assert.match(r.stdout, /opencode doctor/)
})

test('set-model --scope project writes into the working directory', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-model', '--model', 'openrouter/y', '--scope', 'project'], s.home)
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(join(s.home, 'opencode.json'), 'utf8'))
  assert.equal(out.model, 'openrouter/y')
  assert.equal(out.$schema, 'https://opencode.ai/config.json')
})

test('set-model rejects malformed provider/model values before writing', async () => {
  const cases = [
    ['justamodel', /missing the provider\/model slash/],
    ['', /it is empty/],
    ['   ', /only whitespace/],
    ['/model', /leading slash/],
    ['provider/', /trailing slash/],
    ['provider//model', /consecutive slashes/],
  ]

  for (const [model, reason] of cases) {
    const s = await sandbox()
    const r = await cli(s.env, ['set-model', '--model', model])
    assert.equal(r.code, 2, model || '(empty)')
    assert.match(r.stderr, reason)
    assert.match(r.stderr, /expected provider\/model form/)
    await assert.rejects(() => stat(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')))
    await assert.rejects(() => stat(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc')))
  }
})

test('models lists what the binary reports and filters by provider', async () => {
  const s = await sandbox({ FAKE_OPENCODE_MODELS: 'a/one,a/two,b/three' })
  const all = await cli(s.env, ['models'])
  assert.equal(all.code, 0)
  assert.deepEqual(all.stdout.trim().split('\n'), ['a/one', 'a/two', 'b/three'])
  const filtered = await cli(s.env, ['models', '--provider', 'a'])
  assert.equal(filtered.code, 0)
  assert.deepEqual(filtered.stdout.trim().split('\n'), ['a/one', 'a/two'])
})

test('models reports binary failures on stderr with a non-zero exit', async () => {
  const s = await sandbox({ FAKE_OPENCODE_FAULT: 'nonzero-exit' })
  const r = await cli(s.env, ['models'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /opencode models failed for .*fake opencode failed/i)
  assert.equal(r.stdout, '')
})

test('models reports a missing binary as a gap', async () => {
  const s = await sandbox({ OPENCODE_BIN: '/nonexistent/opencode', PATH: '/nonexistent' })
  const r = await cli(s.env, ['models'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /opencode binary unavailable: opencode binary not found/i)
  assert.equal(r.stdout, '')
})

test('models maps a spawn failure to a reported gap', async () => {
  const s = await sandbox()
  const spawnError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  await assert.rejects(
    () => handlers.models({
      flags: {},
      env: s.env,
      resolveBinaryFn: async () => ({ path: '/tmp/unusable-opencode' }),
      runFn: async () => { throw spawnError },
    }),
    error => {
      assert.equal(error.exitCode, 1)
      assert.match(error.message, /opencode binary \/tmp\/unusable-opencode could not be started: permission denied/)
      return true
    },
  )
})

test('models explains empty and unmatched results', async () => {
  const empty = await sandbox({ FAKE_OPENCODE_MODELS: ',' })
  const emptyResult = await cli(empty.env, ['models'])
  assert.equal(emptyResult.code, 0)
  assert.equal(emptyResult.stdout.trim(), 'The opencode binary reported no models at all.')

  const filtered = await sandbox({ FAKE_OPENCODE_MODELS: 'a/one,b/two' })
  const filteredResult = await cli(filtered.env, ['models', '--provider', 'z'])
  assert.equal(filteredResult.code, 0)
  assert.equal(filteredResult.stdout.trim(), 'No models matched provider z.')
})

test('set-key keeps its write report when the post-write doctor fails', async () => {
  const s = await sandbox()
  const auth = join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  const original = '{"anthropic":{"type":"api","key":"KEEP"}}'
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(auth, original)
  const result = await handlers['set-key']({
    flags: { provider: 'openrouter', key: 'sk-or-postwrite' },
    env: s.env,
    cwd: s.home,
    runDoctorFn: async () => { throw new Error('synthetic post-write failure') },
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /Stored a key for openrouter/)
  assert.match(result.stdout, /Backed up the previous file to .*auth\.json\.bak\./)
  assert.match(result.stdout, /Post-write doctor check failed: synthetic post-write failure/)
  assert.deepEqual(JSON.parse(await readFile(auth, 'utf8')).openrouter, {
    type: 'api',
    key: 'sk-or-postwrite',
  })
  assert.equal(await readFile(auth + '.bak', 'utf8'), original)
})

test('set-model keeps its write report when the post-write doctor fails', async () => {
  const s = await sandbox()
  const cfg = join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc')
  const original = '{\n  // keep\n  "model": "old/model"\n}'
  await writeFile(cfg, original)
  const result = await handlers['set-model']({
    flags: { model: 'openrouter/new', scope: 'global' },
    env: s.env,
    cwd: s.home,
    runDoctorFn: async () => { throw new Error('synthetic post-write failure') },
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /Set the default model to openrouter\/new/)
  assert.match(result.stdout, /Backed up the previous file to .*opencode\.jsonc\.bak\./)
  assert.match(result.stdout, /Comments were dropped: yes/)
  assert.match(result.stdout, /Post-write doctor check failed: synthetic post-write failure/)
  assert.equal(JSON.parse(await readFile(cfg, 'utf8')).model, 'openrouter/new')
  assert.equal(await readFile(cfg + '.bak', 'utf8'), original)
})

test('the gate is off by default, toggles, and status is exactly bare on/off', async () => {
  const s = await sandbox()
  assert.equal((await cli(s.env, ['gate', '--status'])).stdout, 'off\n')
  await cli(s.env, ['gate', '--on'])
  assert.equal((await cli(s.env, ['gate', '--status'])).stdout, 'on\n')
  await cli(s.env, ['gate', '--off'])
  assert.equal((await cli(s.env, ['gate', '--status'])).stdout, 'off\n')
})

test('repair clears a stale portfile and reports it', async () => {
  const s = await sandbox()
  const brokerDir = join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'broker')
  await mkdir(brokerDir, { recursive: true })
  await writeFile(join(brokerDir, 'port.json'), JSON.stringify({ port: 1, pid: 2 ** 22, password: 'p', startedAt: 0 }))
  const r = await cli(s.env, ['repair'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Cleared a stale broker portfile\./)
  await assert.rejects(() => readFile(join(brokerDir, 'port.json')), { code: 'ENOENT' })
})
