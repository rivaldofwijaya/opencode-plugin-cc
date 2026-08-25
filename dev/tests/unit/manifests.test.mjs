import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const read = (p) => JSON.parse(readFileSync(root + p, 'utf8'))

test('plugin manifest declares the opencode plugin', () => {
  const m = read('.claude-plugin/plugin.json')
  assert.equal(m.name, 'opencode')
  assert.ok(m.description.length > 0)
  assert.equal(m.hooks, './hooks/hooks.json')
})

test('marketplace entry points at this plugin', () => {
  const m = read('.claude-plugin/marketplace.json')
  assert.equal(m.name, 'opencode-plugin-cc')
  assert.equal(m.plugins.length, 1)
  assert.equal(m.plugins[0].name, 'opencode')
  assert.equal(m.plugins[0].source, './')
})

test('package declares zero runtime dependencies', () => {
  const p = read('package.json')
  assert.equal(p.type, 'module')
  assert.deepEqual(p.dependencies ?? {}, {})
  assert.deepEqual(p.devDependencies ?? {}, {})
})
