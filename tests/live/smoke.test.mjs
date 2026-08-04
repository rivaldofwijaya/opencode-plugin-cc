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
const liveSessionEnvs = new Set()
let liveSessionCounter = 0

function liveEnv() {
  const env = {
    ...process.env,
    CLAUDE_SESSION_ID: `cc-live-${process.pid}-${++liveSessionCounter}`,
  }
  liveSessionEnvs.add(env)
  return env
}

const warn = (message) => {
  try {
    process.stderr.write(`${message}\n`)
  } catch {
    // Cleanup warnings must never turn into a test failure.
  }
}

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
  const pendingSessions = [...liveSessionEnvs]
  liveSessionEnvs.clear()

  for (const env of pendingSessions) {
    try {
      const repair = await run(process.execPath, [companion, 'repair'], { env, timeoutMs: 120000 })
      if (repair.code !== 0) {
        warn(
          `[live cleanup] repair failed for ${env.CLAUDE_SESSION_ID}; `
          + `exit code: ${repair.code}; `
          + `stderr: ${repair.stderr.trim() || '(empty)'}`,
        )
      }
    } catch (error) {
      warn(
        `[live cleanup] repair failed for ${env.CLAUDE_SESSION_ID}; `
        + 'exit code: unavailable (repair threw); '
        + `stderr: ${typeof error?.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : '(unavailable)'}; `
        + `error: ${error?.message ?? String(error)}`,
      )
    }
  }

  for (const d of pending) {
    try {
      await rm(d, { recursive: true, force: true })
    } catch (error) {
      warn(`[live cleanup] could not remove repository ${d}: ${error?.message ?? String(error)}`)
    }
  }
})

test('live: a real review returns findings or a clean report', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\nexport const half = (n) => div(n, 0)\n')
  const env = liveEnv()
  const r = await run(process.execPath, [companion, 'review', '--wait', '--model', model], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /opencode review/)
  assert.ok(r.stdout.length > 40, 'the review produced no meaningful output')
})

test('live: a real task returns model output', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  const env = liveEnv()
  const r = await run(process.execPath, [companion, 'task', '--wait', '--model', model, '--', 'Reply with the single word: ready'], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout.toLowerCase(), /ready/)
})
