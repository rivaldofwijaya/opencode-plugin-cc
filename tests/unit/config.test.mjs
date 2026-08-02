import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_SCHEMA_URL, resolveDefaultModel, configTargetPath, setModel } from '../../scripts/lib/config.mjs'

async function sandbox() {
  const d = await mkdtemp(join(tmpdir(), 'occfg-'))
  const cwd = join(d, 'repo')
  const cfg = join(d, '.config')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(cfg, 'opencode'), { recursive: true })
  return { cwd, env: { HOME: d, XDG_CONFIG_HOME: cfg }, globalDir: join(cfg, 'opencode') }
}

test('resolveDefaultModel returns null when nothing is configured', async () => {
  const s = await sandbox()
  assert.equal(await resolveDefaultModel({ env: s.env, cwd: s.cwd }), null)
})

test('resolveDefaultModel reads a global opencode.jsonc with comments', async () => {
  const s = await sandbox()
  await writeFile(join(s.globalDir, 'opencode.jsonc'),
    '{\n  // chosen by setup\n  "$schema": "https://opencode.ai/config.json",\n  "model": "openrouter/deepseek/deepseek-v4-flash-0731"\n}')
  const r = await resolveDefaultModel({ env: s.env, cwd: s.cwd })
  assert.equal(r.model, 'openrouter/deepseek/deepseek-v4-flash-0731')
  assert.equal(r.source, 'global')
})

test('project config beats global', async () => {
  const s = await sandbox()
  await writeFile(join(s.globalDir, 'opencode.jsonc'), '{"model":"global/m"}')
  await writeFile(join(s.cwd, 'opencode.json'), '{"model":"project/m"}')
  const r = await resolveDefaultModel({ env: s.env, cwd: s.cwd })
  assert.equal(r.model, 'project/m')
  assert.equal(r.source, 'project')
})

test('configTargetPath reuses an existing .jsonc rather than creating a second file', async () => {
  const s = await sandbox()
  await writeFile(join(s.globalDir, 'opencode.jsonc'), '{"model":"a/b"}')
  assert.equal(await configTargetPath({ scope: 'global', env: s.env, cwd: s.cwd }), join(s.globalDir, 'opencode.jsonc'))
})

test('configTargetPath defaults to opencode.json when nothing exists', async () => {
  const s = await sandbox()
  assert.equal(await configTargetPath({ scope: 'project', env: s.env, cwd: s.cwd }), join(s.cwd, 'opencode.json'))
})

test('setModel merges into an existing .jsonc and preserves siblings', async () => {
  const s = await sandbox()
  const f = join(s.globalDir, 'opencode.jsonc')
  await writeFile(f, '{\n  // keep me\n  "theme": "dark",\n  "model": "old/m"\n}')
  const res = await setModel({ model: 'new/m', scope: 'global', env: s.env, cwd: s.cwd })
  assert.equal(res.path, f)
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.equal(out.theme, 'dark')
  assert.equal(out.model, 'new/m')
  assert.equal(res.backup, f + '.bak')
})

test('setModel creates a new config with $schema', async () => {
  const s = await sandbox()
  const res = await setModel({ model: 'openrouter/x', scope: 'project', env: s.env, cwd: s.cwd })
  assert.equal(res.created, true)
  const out = JSON.parse(await readFile(res.path, 'utf8'))
  assert.equal(out.$schema, CONFIG_SCHEMA_URL)
  assert.equal(out.model, 'openrouter/x')
})
