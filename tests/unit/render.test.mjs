import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReview, renderJobList, renderJobResult, renderDoctor, formatElapsed } from '../../scripts/lib/render.mjs'

test('formatElapsed formats seconds, minutes, and hours', () => {
  assert.equal(formatElapsed(4000), '4s')
  assert.equal(formatElapsed(130000), '2m 10s')
  assert.equal(formatElapsed(3_780_000), '1h 3m')
})

test('renderReview orders the full severity set by schema order', () => {
  const inputOrder = ['info', 'low', 'medium', 'high', 'critical']
  const details = {
    critical: { file: 'a.js', line: 9, title: 'Critical title', body: 'critical body' },
    high: { file: 'b.js', line: 2, title: 'High title', body: 'high body' },
  }
  const out = renderReview({
    ok: true,
    findings: inputOrder.map(severity => ({
      ...details[severity],
      file: details[severity]?.file ?? `${severity}.js`,
      line: details[severity]?.line ?? 1,
      title: details[severity]?.title ?? `${severity} title`,
      severity,
      confidence: 'high',
      body: details[severity]?.body ?? `${severity} body`,
    })),
  }, { scope: 'working-tree', base: null, truncated: false, jobId: 'job_1' })
  const actual = [...out.matchAll(/^\[([A-Z]+)\]/gm)].map(match => match[1])
  assert.deepEqual(actual, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'])
  assert.match(out, /a\.js:9/)
  assert.match(out, /b\.js:2/)
  assert.match(out, /Critical title/)
  assert.match(out, /High title/)
  assert.match(out, /critical body/)
  assert.match(out, /high body/)
})

test('renderReview states plainly when there are no findings', () => {
  const out = renderReview({ ok: true, summary: 'clean', findings: [] }, { scope: 'branch', base: 'main', truncated: false, jobId: 'job_1' })
  assert.match(out, /No findings/)
})

test('renderReview prints raw output with a note when parsing failed', () => {
  const out = renderReview({ ok: false, findings: [], summary: null, raw: 'MODEL SAID THIS', error: 'no JSON object found' },
    { scope: 'working-tree', base: null, truncated: false, jobId: 'job_1' })
  assert.match(out, /MODEL SAID THIS/)
  assert.match(out, /could not be parsed/i)
  assert.match(out, /no JSON object found/)
})

test('renderReview notes a truncated diff', () => {
  const out = renderReview({ ok: true, summary: 's', findings: [] }, { scope: 'working-tree', base: null, truncated: true, jobId: 'job_1' })
  assert.match(out, /truncated/i)
})

test('renderReview says when a supposedly valid finding is incomplete', () => {
  const out = renderReview({ ok: true, summary: 's', findings: [{ file: 'a.js', severity: 'high', confidence: 'high' }] },
    { scope: 'working-tree', base: null, truncated: false, jobId: 'job_1' })
  assert.match(out, /missing.*body|incomplete/i)
})

test('renderJobList shows id, verb, state, elapsed, and counters', () => {
  const now = 1_000_000
  const out = renderJobList([
    { id: 'job_a', verb: 'review', state: 'running', startedAt: now - 5000, endedAt: null, counters: { steps: 2, tools: 3, inputTokens: 10, outputTokens: 20 } },
  ], now)
  assert.match(out, /job_a/)
  assert.match(out, /review/)
  assert.match(out, /running/)
  assert.match(out, /5s/)
  assert.match(out, /3 tools/)
})

test('renderJobList says so when there are no jobs', () => {
  assert.match(renderJobList([]), /No opencode jobs/)
})

test('renderJobResult banners a still-running job above its partial output', () => {
  const out = renderJobResult({ id: 'job_a', verb: 'review', state: 'running', startedAt: 0, counters: {} }, 'partial text')
  assert.match(out, /still running/i)
  assert.match(out, /partial text/)
})

test('renderJobResult reports a job with no output yet', () => {
  const out = renderJobResult({ id: 'job_a', verb: 'task', state: 'running', startedAt: 0, counters: {} }, null)
  assert.match(out, /no output yet/i)
})

test('renderJobResult keeps terminal state and truncation visible out of context', () => {
  const out = renderJobResult({
    id: 'job_a', verb: 'review', state: 'cancelled', startedAt: 1_000,
    endedAt: 2_000, meta: { truncated: true }, counters: {},
  }, null)
  assert.match(out, /cancelled/i)
  assert.match(out, /truncated/i)
  assert.match(out, /started|ended/i)
})

test('renderDoctor prints the status table and gaps', () => {
  const out = renderDoctor({
    ok: false,
    binary: { ok: true, path: '/usr/local/bin/opencode', source: 'PATH' },
    version: { ok: false, value: '1.0.0', floor: '1.2.0' },
    auth: { ok: true, providers: ['openrouter'] },
    model: { ok: false, value: null, source: null, path: null },
    server: { ok: true, detail: 'reachable' },
    gaps: ['version is too old', 'no default model'],
  })
  assert.match(out, /opencode doctor/)
  assert.match(out, /GAP.*version/)
  assert.match(out, /version is too old/)
  assert.match(out, /\/usr\/local\/bin\/opencode/)
})
