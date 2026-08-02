import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stateRoot, jobsDir, jobDir, readJson, writeJson, appendJsonl, readJsonl } from '../../scripts/lib/state.mjs'

test('stateRoot honours XDG_STATE_HOME then falls back to ~/.local/state', () => {
  assert.equal(stateRoot({ XDG_STATE_HOME: '/x' }), '/x/opencode-plugin-cc')
  assert.equal(stateRoot({ HOME: '/h' }), '/h/.local/state/opencode-plugin-cc')
})

test('jobDir nests under jobs/', () => {
  const env = { XDG_STATE_HOME: '/x' }
  assert.equal(jobsDir(env), '/x/opencode-plugin-cc/jobs')
  assert.equal(jobDir('job_1', env), '/x/opencode-plugin-cc/jobs/job_1')
})

test('writeJson then readJson round-trips', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  const f = join(d, 'nested', 'meta.json')
  await writeJson(f, { a: 1 })
  assert.deepEqual(await readJson(f), { a: 1 })
})

test('readJson returns the fallback for a missing or corrupt file', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  assert.deepEqual(await readJson(join(d, 'nope.json'), { d: true }), { d: true })
  const bad = join(d, 'bad.json')
  await appendFile(bad, '{not json')
  assert.deepEqual(await readJson(bad, { d: true }), { d: true })
})

test('appendJsonl appends and readJsonl skips corrupt lines', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  const f = join(d, 'events.jsonl')
  await appendJsonl(f, { n: 1 })
  await appendJsonl(f, { n: 2 })
  await appendFile(f, 'garbage\n')
  await appendJsonl(f, { n: 3 })
  assert.deepEqual(await readJsonl(f), [{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('readJsonl returns [] for a missing file', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  assert.deepEqual(await readJsonl(join(d, 'nope.jsonl')), [])
})

test('readJson and readJsonl rethrow non-ENOENT, non-parse errors', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  await assert.rejects(readJson(d), error => error.code === 'EISDIR')
  await assert.rejects(readJsonl(d), error => error.code === 'EISDIR')
})
