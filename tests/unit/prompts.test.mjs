import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPrompt, listPrompts } from '../../scripts/lib/prompts.mjs'

test('all three prompt templates ship', async () => {
  const names = await listPrompts()
  for (const n of ['review', 'adversarial-review', 'stop-review-gate']) assert.ok(names.includes(n), n)
})

test('loadPrompt substitutes placeholders', async () => {
  const out = await loadPrompt('review', { CWD: '/repo', SCOPE: 'working-tree', BASE_NOTE: '', DIFF: 'DIFFHERE' })
  assert.match(out, /\/repo/)
  assert.match(out, /DIFFHERE/)
  assert.equal(out.includes('{{'), false)
})

test('adversarial review supplies a default focus', async () => {
  const out = await loadPrompt('adversarial-review', { CWD: '/repo', SCOPE: 'working-tree', BASE_NOTE: '', DIFF: 'DIFFHERE' })
  assert.match(out, /Focus from the requester: \(none given\)/)
})

test('loadPrompt throws when a placeholder is unfilled', async () => {
  await assert.rejects(() => loadPrompt('review', { CWD: '/r' }), /unknown placeholder/)
})

test('loadPrompt throws for an unknown template', async () => {
  await assert.rejects(() => loadPrompt('nope', {}), /unknown prompt/)
})
