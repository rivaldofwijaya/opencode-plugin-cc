import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

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
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-abcd1234'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\*\*\*\*1234/)
  assert.equal(r.stdout.includes('sk-or-abcd1234'), false)
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
  assert.match(r.stdout, /Backed up the previous file to .*auth\.json\.bak\./)
})

test('set-key without a key exits non-zero with a clear message', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--key/)
})

test('set-key reports a sanitized underlying filesystem error code', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'))
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-neverprint'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /EISDIR/)
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

test('set-model rejects a model without a provider prefix', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-model', '--model', 'justamodel'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /provider\/model/)
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
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /opencode models failed/i)
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
  assert.match(r.stdout, /broker/i)
})
