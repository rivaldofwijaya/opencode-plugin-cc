import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, loadSchema, validateReview, parseReviewOutput } from '../../../src/lib/review-schema.mjs'
import { readJsonc } from '../../../src/lib/fs.mjs'

const execFileAsync = promisify(execFile)
const schemaPath = fileURLToPath(new URL('../../../schemas/review-output.schema.json', import.meta.url))
const reviewSchemaModuleUrl = new URL('../../../src/lib/review-schema.mjs', import.meta.url)

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

test('validateReview derives keys and enums from the loaded schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-review-schema-'))
  const path = join(directory, 'review.jsonc')
  try {
    const schema = await readJsonc(schemaPath)
    schema.properties.severities = { type: 'string' }
    schema.properties.findings.items.properties.file_path = { type: 'string' }
    schema.properties.findings.items.properties.severity.enum = ['blocker', 'high', 'medium', 'low', 'info']
    await writeFile(path, JSON.stringify(schema))

    const changedReport = {
      severities: 'one',
      findings: [{
        file: 'a.js',
        file_path: 'src/a.js',
        severity: 'blocker',
        confidence: 'high',
        body: 'boom',
      }],
    }
    const original = validateReview(changedReport)
    assert.equal(original.ok, false)
    assert.match(original.error, /severities/)

    const changed = await loadSchema(path)
    assert.deepEqual(changed.severityValues, ['blocker', 'high', 'medium', 'low', 'info'])
    assert.equal(validateReview(changedReport, changed).ok, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loadSchema rejects a missing review schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-review-schema-'))
  try {
    await assert.rejects(
      loadSchema(join(directory, 'missing.json')),
      /could not load review schema.*file not found/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('loadSchema rejects a malformed review schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-review-schema-'))
  const path = join(directory, 'malformed.json')
  try {
    await writeFile(path, '{"properties":')
    await assert.rejects(
      loadSchema(path),
      /could not load review schema.*JSON|malformed review schema/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the environment cannot repoint the production review schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc-review-schema-'))
  const path = join(directory, 'permissive.json')
  try {
    const schema = await readJsonc(schemaPath)
    schema.properties.findings.items.properties.severity.enum = ['permissive']
    await writeFile(path, JSON.stringify(schema))

    const report = {
      findings: [{ file: 'a.js', severity: 'permissive', confidence: 'high', body: 'x' }],
    }
    const script = `
      import { validateReview } from ${JSON.stringify(reviewSchemaModuleUrl.href)}
      process.stdout.write(JSON.stringify(validateReview(${JSON.stringify(report)})))
    `
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, OPENCODE_REVIEW_SCHEMA_PATH: path },
    })
    const result = JSON.parse(stdout)
    assert.equal(result.ok, false)
    assert.match(result.error, /severity/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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

for (const unknownKey of ['hallucinated', 'severities', 'file_path', 'finding']) {
  test(`validateReview rejects unknown top-level property ${unknownKey}`, () => {
    const r = validateReview({ findings: [], [unknownKey]: true })
    assert.equal(r.ok, false)
    assert.match(r.error, new RegExp(unknownKey))
  })

  test(`validateReview rejects unknown finding property ${unknownKey}`, () => {
    const r = validateReview({ findings: [{ file: 'a.js', severity: 'high', confidence: 'high', body: 'x', [unknownKey]: true }] })
    assert.equal(r.ok, false)
    assert.match(r.error, new RegExp(unknownKey))
  })
}

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

test('parseReviewOutput reports an empty model response as empty, not as a parse failure', () => {
  const r = parseReviewOutput('')
  assert.equal(r.ok, false)
  assert.equal(r.empty, true)
  assert.match(r.error, /returned no output/i)
  assert.doesNotMatch(r.error, /JSON/)
  assert.deepEqual(r.findings, [])
})

test('parseReviewOutput treats a whitespace-only model response as empty', () => {
  const r = parseReviewOutput('  \n\t\r\n ')
  assert.equal(r.ok, false)
  assert.equal(r.empty, true)
  assert.match(r.error, /returned no output/i)
})

test('parseReviewOutput does not call unparseable non-empty output empty', () => {
  const r = parseReviewOutput('the model rambled and produced no json')
  assert.equal(r.ok, false)
  assert.equal(r.empty, false)
  assert.match(r.error, /no JSON object found/)
})

test('parseReviewOutput keeps raw text for valid JSON that fails the schema', () => {
  const r = parseReviewOutput('{"findings":[{"file":"a.js","severity":"nope","confidence":"high","body":"x"}]}')
  assert.equal(r.ok, false)
  assert.match(r.raw, /nope/)
  assert.match(r.error, /severity/)
})
