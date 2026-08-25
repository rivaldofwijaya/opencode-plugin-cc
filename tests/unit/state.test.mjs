import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, appendFile, chmod, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  stateRoot,
  jobsDir,
  jobDir,
  sessionsDir,
  transfersDir,
  readJson,
  writeJson,
  appendJsonl,
  readJsonl,
  ensureDir,
} from '../../src/lib/state.mjs'
import { hookLogPayload, logHookFailure } from '../../src/lib/hook-io.mjs'

test('stateRoot honours XDG_STATE_HOME then falls back to ~/.local/state', () => {
  assert.equal(stateRoot({ XDG_STATE_HOME: '/x' }), '/x/opencode-plugin-cc')
  assert.equal(stateRoot({ HOME: '/h' }), '/h/.local/state/opencode-plugin-cc')
})

test('hook logger payload forwards only state-root environment values', () => {
  const payload = hookLogPayload({
    hook: 'test',
    event: 'Stop',
    error: new Error('failure'),
    env: { HOME: '/home/test', XDG_STATE_HOME: '/state/test', SECRET: 'do-not-forward' },
  })
  assert.deepEqual(payload.env, { HOME: '/home/test', XDG_STATE_HOME: '/state/test' })
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

test('state directories and files are private, including an existing state tree', async () => {
  const d = await mkdtemp(join(tmpdir(), 'ocstate-'))
  const env = { XDG_STATE_HOME: d, HOME: '/unused' }
  const root = stateRoot(env)
  const legacyJob = join(jobsDir(env), 'legacy-job')
  const legacyDirectories = [root, jobsDir(env), sessionsDir(env), transfersDir(env), legacyJob]
  for (const directory of legacyDirectories) {
    await mkdir(directory, { recursive: true, mode: 0o755 })
    await chmod(directory, 0o755)
  }

  // One operation on a nested state path must repair the legacy-shaped tree;
  // calling ensureDir on each ancestor would only test the old leaf behavior.
  await ensureDir(legacyJob)
  for (const directory of [...legacyDirectories]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory)
  }

  await writeJson(join(jobsDir(env), 'prompt.json'), { prompt: 'secret' })
  await appendJsonl(join(sessionsDir(env), 'events.jsonl'), { event: 'secret' })
  await writeJson(join(transfersDir(env), 'handoff.md'), { conversation: 'secret' })
  await logHookFailure({ hook: 'test', event: 'x', error: new Error('secret'), env })

  for (const file of [
    join(jobsDir(env), 'prompt.json'),
    join(sessionsDir(env), 'events.jsonl'),
    join(transfersDir(env), 'handoff.md'),
    join(root, 'hook-errors.jsonl'),
  ]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600, file)
  }
})
