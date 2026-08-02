import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authFilePath, readAuth, listProviders, envProviderHints, setKey } from '../../scripts/lib/credentials.mjs'

async function home() {
  const d = await mkdtemp(join(tmpdir(), 'ocauth-'))
  return { HOME: d, XDG_DATA_HOME: join(d, '.local', 'share') }
}

test('authFilePath honours XDG_DATA_HOME then HOME', () => {
  assert.equal(authFilePath({ XDG_DATA_HOME: '/d' }), '/d/opencode/auth.json')
  assert.equal(authFilePath({ HOME: '/h' }), '/h/.local/share/opencode/auth.json')
})

test('readAuth returns {} when the file is absent', async () => {
  assert.deepEqual(await readAuth(await home()), {})
})

test('listProviders returns sorted provider names', async () => {
  const env = await home()
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(authFilePath(env), JSON.stringify({ openrouter: { type: 'api' }, anthropic: { type: 'api' } }))
  assert.deepEqual(await listProviders(env), ['anthropic', 'openrouter'])
})

test('envProviderHints detects keys already in the environment', async () => {
  const env = { ...(await home()), ANTHROPIC_API_KEY: 'x', GROQ_API_KEY: 'y' }
  const hints = await envProviderHints(env)
  assert.deepEqual(hints.map(h => h.provider).sort(), ['anthropic', 'groq'])
})

test('setKey preserves other providers and writes 0600', async () => {
  const env = await home()
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  const p = authFilePath(env)
  await writeFile(p, JSON.stringify({ openrouter: { type: 'api', key: 'KEEP' } }), { mode: 0o644 })
  const res = await setKey({ provider: 'anthropic', key: 'sk-ant-abcd1234', env })
  const out = JSON.parse(await readFile(p, 'utf8'))
  assert.equal(out.openrouter.key, 'KEEP')
  assert.deepEqual(out.anthropic, { type: 'api', key: 'sk-ant-abcd1234' })
  assert.equal((await stat(p)).mode & 0o777, 0o600)
  assert.equal(res.redacted, '****1234')
  assert.equal(res.backup, p + '.bak')
})

test('setKey creates auth.json at 0600 when absent', async () => {
  const env = await home()
  const res = await setKey({ provider: 'openrouter', key: 'sk-or-wxyz9876', env })
  assert.equal(res.created, true)
  assert.equal((await stat(authFilePath(env))).mode & 0o777, 0o600)
})

test('setKey rejects an empty provider or key', async () => {
  const env = await home()
  await assert.rejects(() => setKey({ provider: '', key: 'k', env }), /provider/)
  await assert.rejects(() => setKey({ provider: 'p', key: '', env }), /key/)
})

test('setKey never returns the raw key', async () => {
  const env = await home()
  const res = await setKey({ provider: 'openrouter', key: 'sk-or-secret-tail', env })
  assert.equal(JSON.stringify(res).includes('secret'), false)
})
