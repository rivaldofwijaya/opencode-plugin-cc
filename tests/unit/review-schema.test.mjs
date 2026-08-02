import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, validateReview, parseReviewOutput } from '../../scripts/lib/review-schema.mjs'

test('extractJson finds a bare object', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}')
})

test('extractJson strips a fenced block and surrounding prose', () => {
  assert.equal(extractJson('Here you go:\n```json\n{"a":1}\n```\nthanks'), '{"a":1}')
})

test('extractJson handles braces inside strings', () => {
  assert.equal(extractJson('{"body":"use {} carefully"}'), '{"body":"use {} carefully"}')
})

test('extractJson returns null when there is no object', () => {
  assert.equal(extractJson('no json here'), null)
})

test('extractJson returns null for a truncated object', () => {
  assert.equal(extractJson('{"findings":['), null)
})

test('validateReview accepts a well-formed report', () => {
  const r = validateReview({ summary: 's', findings: [{ file: 'a.js', line: 1, severity: 'high', confidence: 'high', body: 'boom' }] })
  assert.equal(r.ok, true)
  assert.equal(r.findings.length, 1)
})

test('validateReview accepts an empty findings list', () => {
  assert.equal(validateReview({ findings: [] }).ok, true)
})

test('validateReview accepts a null line and an empty optional title', () => {
  const r = validateReview({ findings: [{ file: 'a.js', line: null, title: '', severity: 'info', confidence: 'low', body: 'note' }] })
  assert.equal(r.ok, true)
})

test('validateReview rejects a non-object report', () => {
  const r = validateReview([])
  assert.equal(r.ok, false)
  assert.match(r.error, /JSON object/)
})

test('validateReview rejects a bad severity', () => {
  const r = validateReview({ findings: [{ file: 'a.js', severity: 'catastrophic', confidence: 'high', body: 'x' }] })
  assert.equal(r.ok, false)
  assert.match(r.error, /severity/)
})

test('validateReview rejects a bad confidence', () => {
  const r = validateReview({ findings: [{ file: 'a.js', severity: 'high', confidence: 'certain', body: 'x' }] })
  assert.equal(r.ok, false)
  assert.match(r.error, /confidence/)
})

test('validateReview rejects a missing required field', () => {
  const r = validateReview({ findings: [{ file: 'a.js', severity: 'high', confidence: 'high' }] })
  assert.equal(r.ok, false)
  assert.match(r.error, /body/)
})

test('validateReview rejects a non-array findings value', () => {
  const r = validateReview({ findings: 'lots' })
  assert.equal(r.ok, false)
  assert.match(r.error, /findings.*array/)
})

test('validateReview rejects an unknown top-level property by name', () => {
  const r = validateReview({ findings: [], hallucinated: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /hallucinated/)
})

test('validateReview rejects an unknown finding property by name', () => {
  const r = validateReview({ findings: [{ file: 'a.js', severity: 'high', confidence: 'high', body: 'x', hallucinated: true }] })
  assert.equal(r.ok, false)
  assert.match(r.error, /hallucinated/)
})

test('validateReview rejects an invalid line', () => {
  const r = validateReview({ findings: [{ file: 'a.js', line: 0, severity: 'high', confidence: 'high', body: 'x' }] })
  assert.equal(r.ok, false)
  assert.match(r.error, /line/)
})

test('validateReview rejects empty file and body strings', () => {
  const emptyFile = validateReview({ findings: [{ file: '', severity: 'high', confidence: 'high', body: 'x' }] })
  const emptyBody = validateReview({ findings: [{ file: 'a.js', severity: 'high', confidence: 'high', body: '' }] })
  assert.equal(emptyFile.ok, false)
  assert.equal(emptyBody.ok, false)
})

test('parseReviewOutput returns findings for good output', () => {
  const r = parseReviewOutput('```json\n{"summary":"ok","findings":[{"file":"a.js","line":3,"severity":"low","confidence":"medium","body":"nit"}]}\n```')
  assert.equal(r.ok, true)
  assert.equal(r.summary, 'ok')
  assert.equal(r.findings[0].file, 'a.js')
})

test('parseReviewOutput reports malformed JSON and keeps raw text', () => {
  const raw = '{"findings":}'
  const r = parseReviewOutput(raw)
  assert.equal(r.ok, false)
  assert.equal(r.raw, raw)
  assert.match(r.error, /malformed JSON/)
  assert.deepEqual(r.findings, [])
})

test('parseReviewOutput never throws and keeps the raw text', () => {
  const r = parseReviewOutput('the model rambled and produced no json')
  assert.equal(r.ok, false)
  assert.equal(r.raw, 'the model rambled and produced no json')
  assert.ok(r.error)
  assert.deepEqual(r.findings, [])
})

test('parseReviewOutput keeps raw text for valid JSON that fails the schema', () => {
  const r = parseReviewOutput('{"findings":[{"file":"a.js","severity":"nope","confidence":"high","body":"x"}]}')
  assert.equal(r.ok, false)
  assert.match(r.raw, /nope/)
  assert.match(r.error, /severity/)
})
