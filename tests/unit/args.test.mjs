import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../../scripts/lib/args.mjs'

test('parses the verb and leaves flags empty', () => {
  assert.deepEqual(parseArgs(['doctor']), { verb: 'doctor', flags: {}, positional: [] })
})

test('boolean flags, valued flags, equals form, and negation', () => {
  const r = parseArgs(['review', '--background', '--base', 'main', '--scope=branch', '--no-auto'])
  assert.equal(r.verb, 'review')
  assert.deepEqual(r.flags, { background: true, base: 'main', scope: 'branch', auto: false })
})

test('short flags take a value', () => {
  assert.deepEqual(parseArgs(['task', '-m', 'openrouter/x']).flags, { m: 'openrouter/x' })
})

test('everything after -- is positional', () => {
  const r = parseArgs(['task', '--background', '--', 'fix', '--the', 'bug'])
  assert.deepEqual(r.positional, ['fix', '--the', 'bug'])
  assert.deepEqual(r.flags, { background: true })
})

test('bare words after the verb are positional', () => {
  assert.deepEqual(parseArgs(['result', 'job_123']).positional, ['job_123'])
})

test('empty argv yields a null verb', () => {
  assert.equal(parseArgs([]).verb, null)
})
