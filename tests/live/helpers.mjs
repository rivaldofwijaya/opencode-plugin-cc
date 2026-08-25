import { afterEach } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cancelJob } from '../../src/lib/job-control.mjs'
import { run } from '../../src/lib/process.mjs'
import { listJobs } from '../../src/lib/tracked-jobs.mjs'

export const companion = fileURLToPath(new URL('../../src/opencode-companion.mjs', import.meta.url))
export const live = process.env.OPENCODE_LIVE === '1'
export const model = process.env.OPENCODE_LIVE_MODEL || 'openrouter/openai/gpt-oss-20b:free'
// Only the tool-counter test uses this; the free default may not call tools.
export const toolModel = process.env.OPENCODE_LIVE_TOOL_MODEL || model

const repos = new Set()
const liveSessionEnvs = new Set()
let liveSessionCounter = 0
const TERMINAL_JOB_STATES = new Set(['done', 'failed', 'cancelled', 'timed-out', 'stale'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function liveEnv(extra = {}) {
  const env = {
    ...process.env,
    CLAUDE_SESSION_ID: `cc-${process.pid.toString(16)}-${(++liveSessionCounter).toString(16)}`,
    ...extra,
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

export async function repo() {
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

// A status line is: "  <id>  <verb padded>  <state padded>  <elapsed> ..."
export function jobLine(stdout, jobId) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes(jobId)) return line
  }
  return null
}

export function jobState(stdout, jobId) {
  const line = jobLine(stdout, jobId)
  if (!line) return null
  const fields = line.trim().split(/\s+/)
  return fields[2] ?? null
}

/**
 * Run `companion status` until `predicate` accepts its stdout. On timeout the
 * rejection carries the last status seen, so a stuck poll reports the state the
 * job was actually in rather than only that time ran out.
 */
export async function pollStatus(env, cwd, predicate, { timeoutMs = 240000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let last = '(status never produced output)'
  while (Date.now() < deadline) {
    attempts += 1
    const r = await run(process.execPath, [companion, 'status'], { cwd, env, timeoutMs: 60000 })
    last = `exit ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr.trim() || '(empty)'}`
    if (r.code === 0 && predicate(r.stdout)) return r.stdout
    await sleep(intervalMs)
  }
  throw new Error(`pollStatus gave up after ${timeoutMs}ms and ${attempts} status runs; last status was:\n${last}`)
}

afterEach(async () => {
  const pending = [...repos]
  repos.clear()
  const pendingSessions = [...liveSessionEnvs]
  liveSessionEnvs.clear()

  for (const env of pendingSessions) {
    try {
      const jobs = await listJobs(env.CLAUDE_SESSION_ID, env)
      for (const job of jobs) {
        if (TERMINAL_JOB_STATES.has(job.state)) continue
        try {
          await cancelJob(job.id, env)
        } catch (error) {
          warn(
            `[live cleanup] cancel failed for ${job.id} in ${env.CLAUDE_SESSION_ID}; `
            + `error: ${error?.message ?? String(error)}`,
          )
        }
      }
    } catch (error) {
      warn(
        `[live cleanup] could not enumerate jobs for ${env.CLAUDE_SESSION_ID}; `
        + `error: ${error?.message ?? String(error)}`,
      )
    }

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
