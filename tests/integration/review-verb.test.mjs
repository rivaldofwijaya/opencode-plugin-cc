import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'
import { cancelJob } from '../../scripts/lib/job-control.mjs'
import { readJob } from '../../scripts/lib/tracked-jobs.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const bindFailure = (detail) => /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(String(detail))

function skipBindFailure(t, result) {
  if (result.code === 3 && bindFailure(`${result.stdout}\n${result.stderr}`)) {
    t.skip(`loopback binding is unavailable in this sandbox: ${result.stderr.trim()}`)
    return true
  }
  return false
}

async function repoSandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocrev-'))
  const repo = join(home, 'repo')
  await mkdir(repo, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-review',
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  const git = (...a) => run('git', a, { cwd: repo, env })
  await git('init', '-b', 'main')
  await writeFile(join(repo, 'a.js'), 'let x = 1\n')
  await git('add', '.')
  await git('commit', '-m', 'init')
  return { env, repo, git }
}

const cli = (env, cwd, args) => run(process.execPath, [companion, ...args], { env, cwd, timeoutMs: 60000 })

test('review-size reports an empty clean tree', async () => {
  const s = await repoSandbox()
  const r = await cli(s.env, s.repo, ['review-size', '--json'])
  assert.equal(r.code, 0)
  const size = JSON.parse(r.stdout)
  assert.equal(size.empty, true)
  assert.equal(size.scope, 'working-tree')
})

test('review-size counts untracked files as reviewable work', async () => {
  const s = await repoSandbox()
  await writeFile(join(s.repo, 'new.js'), 'const y = 2\n')
  const size = JSON.parse((await cli(s.env, s.repo, ['review-size', '--json'])).stdout)
  assert.equal(size.empty, false)
  assert.deepEqual(size.untracked, ['new.js'])
  assert.equal(size.tiny, true)
})

test('review --wait renders parsed findings', async (t) => {
  const s = await repoSandbox()
  await writeFile(join(s.repo, 'a.js'), 'let x = 1\nlet z = null.foo\n')
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0)
  assert.match(r.stdout, /opencode review/)
  assert.match(r.stdout, /HIGH/)
  assert.match(r.stdout, /Null deref/)
})

test('review refuses when there is nothing to review', async () => {
  const s = await repoSandbox()
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /nothing to review/i)
})

test('review --background returns a job id immediately', async (t) => {
  const s = await repoSandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '150' })
  await writeFile(join(s.repo, 'a.js'), 'let x = 2\n')
  const r = await cli(s.env, s.repo, ['review', '--background'])
  if (skipBindFailure(t, r)) return
  const jobId = r.stdout.match(/job_[a-z0-9]+/)?.[0]
  try {
    assert.equal(r.code, 0)
    assert.ok(jobId)
    assert.match(r.stdout, /\/opencode:result/)
  } finally {
    if (jobId) {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && (await readJob(jobId, s.env))?.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await cancelJob(jobId, s.env).catch(() => {})
    }
  }
})

test('unparseable model output is rendered raw, never discarded', async (t) => {
  const s = await repoSandbox({ FAKE_OPENCODE_FAULT: 'malformed-json' })
  await writeFile(join(s.repo, 'a.js'), 'let x = 3\n')
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0)
  assert.match(r.stdout, /could not be parsed/i)
  assert.match(r.stdout, /not json at all/)
})

test('review blocks with a setup pointer when no model is configured', async () => {
  const s = await repoSandbox()
  await writeFile(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{}')
  await writeFile(join(s.repo, 'a.js'), 'let x = 4\n')
  const r = await cli(s.env, s.repo, ['review', '--wait'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /no default model/)
  assert.match(r.stderr, /\/opencode:setup/)
})

test('adversarial-review accepts focus text and still renders findings', async (t) => {
  const s = await repoSandbox()
  await writeFile(join(s.repo, 'a.js'), 'let x = 5\n')
  const r = await cli(s.env, s.repo, ['adversarial-review', '--wait', '--', 'is the retry loop sound?'])
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0)
  assert.match(r.stdout, /opencode review/)
})

test('review --scope branch diffs against the base', async (t) => {
  const s = await repoSandbox()
  await s.git('branch', 'base-ref')
  await writeFile(join(s.repo, 'b.js'), 'const b = 1\n')
  await s.git('add', '.')
  await s.git('commit', '-m', 'second')
  const r = await cli(s.env, s.repo, ['review', '--wait', '--scope', 'branch', '--base', 'base-ref'])
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0)
  assert.match(r.stdout, /branch diff vs base-ref/)
})
