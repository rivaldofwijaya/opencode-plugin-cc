import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const live = process.env.OPENCODE_LIVE === '1'
const model = process.env.OPENCODE_LIVE_MODEL || 'openrouter/openai/gpt-oss-20b:free'
const repos = new Set()

async function repo() {
  const d = await mkdtemp(join(tmpdir(), 'oclive-'))
  repos.add(d)
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
    const git = (...a) => run('git', a, { cwd: d, env })
    await git('init', '-b', 'main')
    await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\n')
    await git('add', '.')
    await git('commit', '-m', 'init')
    return d
  } catch (error) {
    repos.delete(d)
    await rm(d, { recursive: true, force: true })
    throw error
  }
}

afterEach(async () => {
  const pending = [...repos]
  repos.clear()
  await Promise.all(pending.map(d => rm(d, { recursive: true, force: true })))
})

test('live: a real review returns findings or a clean report', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\nexport const half = (n) => div(n, 0)\n')
  const r = await run(process.execPath, [companion, 'review', '--wait', '--model', model], {
    cwd: d,
    env: { ...process.env, CLAUDE_SESSION_ID: 'cc-live' },
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /opencode review/)
  assert.ok(r.stdout.length > 40, 'the review produced no meaningful output')
})

test('live: a real task returns model output', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  const r = await run(process.execPath, [companion, 'task', '--wait', '--model', model, '--', 'Reply with the single word: ready'], {
    cwd: d,
    env: { ...process.env, CLAUDE_SESSION_ID: 'cc-live' },
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout.toLowerCase(), /ready/)
})
