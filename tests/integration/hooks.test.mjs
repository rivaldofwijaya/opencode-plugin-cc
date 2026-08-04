import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { isAlive, run, spawnDetached, terminate } from '../../scripts/lib/process.mjs'
import { createJob, listJobs, readJob, updateJob } from '../../scripts/lib/tracked-jobs.mjs'
import { brokerDir, jobDir, readJson, writeJson } from '../../scripts/lib/state.mjs'
import { refsPath, readEndpoint, writeEndpoint } from '../../scripts/lib/broker-endpoint.mjs'
import { shutdownBroker } from '../../scripts/lib/broker-lifecycle.mjs'
import { prepareReview } from '../../scripts/lib/review-job.mjs'

const lifecycle = fileURLToPath(new URL('../../scripts/session-lifecycle-hook.mjs', import.meta.url))
const gate = fileURLToPath(new URL('../../scripts/stop-review-gate-hook.mjs', import.meta.url))
const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const bindFailure = (detail) => /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(String(detail))

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ochook-'))
  const repo = join(home, 'repo')
  await mkdir(repo, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
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
  return { env, home, repo }
}

const hook = (script, args, env, payload, options = {}) =>
  run(process.execPath, [script, ...args], {
    env,
    input: options.rawInput ?? JSON.stringify(payload),
    timeoutMs: options.timeoutMs ?? 60000,
  })

function openPipeHook(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('hook did not close an open stdin pipe'))
    }, 5000)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function withFakeOwnedBroker(env, callback) {
  const child = spawnDetached(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const password = 'test-password'
  const startedAt = Date.now()
  await writeEndpoint({ port: 1, pid: child.pid, password, startedAt }, env)
  await writeJson(join(brokerDir(env), 'owner.json'), {
    pid: child.pid,
    port: 1,
    startedAt,
    passwordHash: createHash('sha256').update(password).digest('hex'),
  })
  try {
    return await callback(child)
  } finally {
    await shutdownBroker(env)
    if (isAlive(child.pid)) await terminate(child.pid, { graceMs: 1000 })
  }
}

test('SessionStart registers the session and exits 0 silently', async () => {
  const s = await sandbox()
  const r = await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
  const sessions = join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')
  assert.deepEqual(await readdir(sessions), ['cc-1.json'])
})

test('SessionStart never blocks even when the binary is missing', async () => {
  const s = await sandbox({ OPENCODE_BIN: '/nonexistent/opencode' })
  const r = await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.deepEqual(
    await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')),
    ['cc-1.json'],
  )
})

test('SessionEnd unregisters only its session and preserves another session holder', async () => {
  const s = await sandbox()
  await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-live', cwd: s.repo })
  await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-end', cwd: s.repo })
  await withFakeOwnedBroker(s.env, async (broker) => {
    const r = await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-end', cwd: s.repo })
    assert.equal(r.code, 0)
    assert.deepEqual(
      await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')),
      ['cc-live.json'],
    )
    assert.equal(isAlive(broker.pid), true)
    assert.ok((await readJson(refsPath(s.env), {}))['cc-live'])

    const final = await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-live', cwd: s.repo })
    assert.equal(final.code, 0)
    assert.deepEqual(await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')), [])
  })
})

test('SessionEnd does not release a migrated holder it did not acquire', async () => {
  const s = await sandbox()
  const legacyAt = Date.now()
  await writeJson(refsPath(s.env), { 'cc-legacy': legacyAt })

  const r = await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-legacy', cwd: s.repo })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.deepEqual(await readJson(refsPath(s.env), {}), { 'cc-legacy': legacyAt })
})

test('SessionEnd cancels this session running jobs', async (t) => {
  const s = await sandbox({ FAKE_OPENCODE_EVENT_DELAY_MS: '400' })
  const started = await run(process.execPath, [companion, 'task', '--background', '--', 'long'],
    { env: { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, cwd: s.repo, timeoutMs: 60000 })
  if (started.code !== 0 && bindFailure(started.stderr)) {
    t.skip(`loopback binding is unavailable in this sandbox: ${started.stderr}`)
    return
  }
  assert.equal(started.code, 0, started.stderr)
  const jobId = started.stdout.match(/(job_[a-z0-9]+)/)[1]
  await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-1', cwd: s.repo })
  const meta = JSON.parse(await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs', jobId, 'meta.json'), 'utf8'))
  assert.ok(['cancelled', 'stale'].includes(meta.state), meta.state)
})

test('SessionEnd does not kill a live background worker', async () => {
  const s = await sandbox()
  const workerToken = 'live-worker-token'
  let worker
  try {
    const job = await createJob({
      ccSessionId: 'cc-live', verb: 'task', cwd: s.repo, background: true,
    }, s.env)
    worker = spawnDetached(process.execPath, [
      '-e', 'setInterval(() => {}, 1000)', '--', '--opencode-job-worker', job.id, workerToken,
    ])
    assert.equal(isAlive(worker.pid), true)
    await updateJob(job.id, { pid: worker.pid, sessionID: 'opencode-session' }, s.env)
    await writeFile(join(jobDir(job.id, s.env), 'worker-owner.json'), JSON.stringify({
      jobId: job.id, pid: worker.pid, workerToken,
    }))
    const r = await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-live', cwd: s.repo })
    assert.equal(r.code, 0)
    assert.equal(isAlive(worker.pid), true)
    assert.equal((await readJob(job.id, s.env)).state, 'cancelled')
  } finally {
    if (worker?.pid) await terminate(worker.pid, { graceMs: 1000 })
  }
})

test('SessionStart accepts malformed stdin without a stack trace and uses the env fallback', async () => {
  const s = await sandbox({ CLAUDE_SESSION_ID: 'fallback-session' })
  const r = await hook(lifecycle, ['SessionStart'], s.env, null, { rawInput: '{"session_id":' })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.doesNotMatch(r.stderr, /SyntaxError|at .*session-lifecycle-hook/)
  assert.deepEqual(await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')), ['fallback-session.json'])
})

test('SessionStart times out an open stdin pipe instead of wedging', async () => {
  const s = await sandbox({ CLAUDE_SESSION_ID: 'open-pipe-session' })
  const startedAt = Date.now()
  const r = await openPipeHook(lifecycle, ['SessionStart'], s.env)
  assert.ok(Date.now() - startedAt < 900, 'lifecycle hook waited too long for stdin')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.doesNotMatch(r.stderr, /SyntaxError|at .*session-lifecycle-hook/)
  assert.deepEqual(
    await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'sessions')),
    ['open-pipe-session.json'],
  )
})

test('lifecycle failures exit 0 and are persisted in the state directory', async () => {
  const s = await sandbox()
  const root = join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'jobs'), 'not a directory')
  const r = await hook(lifecycle, ['SessionStart'], s.env, { session_id: 'cc-failure', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.doesNotMatch(r.stderr, /SyntaxError|at .*session-lifecycle-hook/)
  const log = await readFile(join(root, 'hook-errors.jsonl'), 'utf8')
  assert.match(log, /"event":"SessionStart"/)
  assert.match(log, /ENOTDIR|not a directory/)

  const hanging = await sandbox()
  const hangingRoot = join(hanging.env.XDG_STATE_HOME, 'opencode-plugin-cc')
  await mkdir(hangingRoot, { recursive: true })
  const fifo = join(hangingRoot, 'hook-errors.jsonl')
  const fifoResult = await run('mkfifo', [fifo], { env: hanging.env })
  assert.equal(fifoResult.code, 0, fifoResult.stderr)
  const startedAt = Date.now()
  const timed = await hook(
    lifecycle,
    ['unknown'],
    hanging.env,
    {},
    { timeoutMs: 1500 },
  )
  assert.equal(timed.code, 0, JSON.stringify(timed))
  assert.equal(timed.timedOut, false, 'hook wedged in failure logging')
  assert.ok(Date.now() - startedAt < 1000, 'bounded failure logging exceeded its budget')
})

test('lifecycle exits 0 when the failure logger rejects inside its own path', async () => {
  const s = await sandbox({ OPENCODE_TEST_THROW_HOOK_FAILURE_LOGGING: '1' })
  const startedAt = Date.now()
  const r = await hook(lifecycle, ['unknown'], s.env, {}, { timeoutMs: 1000 })
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.timedOut, false, 'structural exit guard did not run')
  assert.ok(Date.now() - startedAt < 900, 'failure-log construction exceeded the hook budget')
})

test('SessionEnd exits promptly after quick work instead of waiting for the hard watchdog', async () => {
  const s = await sandbox()
  const startedAt = Date.now()
  const r = await hook(lifecycle, ['SessionEnd'], s.env, { session_id: 'cc-fast-end', cwd: s.repo })
  const elapsed = Date.now() - startedAt
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.timedOut, false, 'SessionEnd exceeded the harness budget')
  assert.ok(elapsed < 900, `fast SessionEnd lingered for ${elapsed}ms`)
})

test('lifecycle hard watchdog exits 0 near its deadline when work never settles', async () => {
  const s = await sandbox({ OPENCODE_TEST_HANG_LIFECYCLE_WORK: '1' })
  const startedAt = Date.now()
  const r = await hook(
    lifecycle,
    ['SessionStart'],
    s.env,
    { session_id: 'cc-watchdog', cwd: s.repo },
    { timeoutMs: 1800 },
  )
  const elapsed = Date.now() - startedAt
  assert.equal(r.code, 0, JSON.stringify(r))
  assert.equal(r.timedOut, false, 'hard watchdog did not terminate the hook')
  assert.ok(elapsed >= 1050, `watchdog fired too early: ${elapsed}ms`)
  assert.ok(elapsed < 1450, `watchdog exceeded the 1.5s SessionEnd budget: ${elapsed}ms`)
})

test('the Stop gate is silent when it is off', async () => {
  const s = await sandbox()
  await writeFile(join(s.repo, 'a.js'), 'let x = 2\n')
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
})

test('the Stop gate skips an open stdin pipe immediately when it is off', async () => {
  const s = await sandbox()
  const startedAt = Date.now()
  const r = await openPipeHook(gate, [], s.env)
  assert.ok(Date.now() - startedAt < 900, 'gate-off hook waited for stdin')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
})

test('the Stop gate blocks on a high-severity finding when it is on', async (t) => {
  const s = await sandbox()
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 2\n')
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  if (!r.stdout.trim()) {
    const errors = await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'hook-errors.jsonl'), 'utf8').catch(() => '')
    if (bindFailure(errors)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${errors}`)
      return
    }
  }
  const decision = JSON.parse(r.stdout)
  assert.equal(decision.decision, 'block')
  assert.match(decision.reason, /Null deref/)
  assert.match(decision.reason, /Address these or explain why they are acceptable/)
})

test('the Stop gate is silent on a clean tree even when on', async () => {
  const s = await sandbox()
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
  assert.deepEqual(
    await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs')).catch(() => []),
    [],
  )
})

test('the Stop gate is silent when only low-severity findings come back', async (t) => {
  const s = await sandbox()
  const script = join(s.home, 'low.jsonl')
  await writeFile(script, [
    JSON.stringify({ type: 'message.updated', properties: { info: { id: 'msg_fake_1', role: 'assistant' } } }),
    JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_fake_text', messageID: 'msg_fake_1', type: 'text' } } }),
    JSON.stringify({ type: 'message.part.delta', properties: { messageID: 'msg_fake_1', partID: 'prt_fake_text', field: 'text', delta: '{"findings":[{"file":"a.js","line":1,"severity":"low","confidence":"low","body":"nit"}]}' } }),
    JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_fake_text', messageID: 'msg_fake_1', type: 'text', text: '{"findings":[{"file":"a.js","line":1,"severity":"low","confidence":"low","body":"nit"}]}' } } }),
    JSON.stringify({ type: 'session.idle', properties: {} }),
  ].join('\n') + '\n')
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 3\n')
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1', FAKE_OPENCODE_SCRIPT: script }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
  const errors = await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'hook-errors.jsonl'), 'utf8').catch(() => '')
  if (bindFailure(errors)) {
    t.skip(`loopback binding is unavailable in this sandbox: ${errors}`)
    return
  }
  const jobs = await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs'))
  assert.equal(jobs.length, 1)
  const result = await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs', jobs[0], 'result.md'), 'utf8')
  assert.match(result, /"severity":"low"/)
})

test('the Stop gate exits 0 silently when opencode is not ready', async () => {
  const s = await sandbox()
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 4\n')
  const r = await hook(gate, [], { ...s.env, OPENCODE_BIN: '/nonexistent/opencode', CLAUDE_SESSION_ID: 'cc-1' }, { session_id: 'cc-1', cwd: s.repo })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
})

test('the Stop gate review stays foreground and leaves no detached worker', async (t) => {
  const source = await readFile(gate, 'utf8')
  const startCall = source.match(/const execution = await startJob\(\{([\s\S]*?)\n  \}\)/)?.[1]
  assert.ok(startCall, 'Stop gate startJob call not found')
  assert.match(startCall, /\bbackground:\s*false\b/)

  const s = await sandbox({
    FAKE_OPENCODE_EVENT_DELAY_MS: '1000',
    OPENCODE_STOP_GATE_TIMEOUT_MS: '600',
  })
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 7\n')
  const r = await hook(
    gate,
    [],
    { ...s.env, CLAUDE_SESSION_ID: 'cc-timeout' },
    { session_id: 'cc-timeout', cwd: s.repo },
    { timeoutMs: 5000 },
  )
  assert.equal(r.code, 0)
  assert.equal(r.timedOut, false, 'Stop hook exceeded the harness budget')
  if (!r.stdout.trim()) {
    const errors = await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'hook-errors.jsonl'), 'utf8').catch(() => '')
    if (bindFailure(errors)) {
      t.skip(`loopback binding is unavailable in this sandbox: ${errors}`)
      return
    }
  }
  const jobs = await readdir(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs'))
  assert.equal(jobs.length, 1)
  const meta = JSON.parse(await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs', jobs[0], 'meta.json'), 'utf8'))
  assert.equal(meta.state, 'cancelled')
  assert.equal(
    await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'jobs', jobs[0], 'worker-owner.json'), 'utf8').catch(() => null),
    null,
    'foreground Stop review left a detached worker owner record',
  )
  assert.deepEqual(await readJson(refsPath(s.env), {}), {})
  assert.equal(await readEndpoint(s.env), null)
})

test('concurrent Stop gates cancel only the review job each hook created', async (t) => {
  const s = await sandbox()
  const script = join(s.home, 'slow-gate.jsonl')
  await writeFile(script, [
    JSON.stringify({ type: 'message.updated', properties: { info: { id: 'msg_fake_1', role: 'assistant' } } }),
    JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_fake_text', messageID: 'msg_fake_1', type: 'text' } } }),
    JSON.stringify({
      type: 'message.part.delta',
      properties: { messageID: 'msg_fake_1', partID: 'prt_fake_text', field: 'text', delta: '{"findings":[]}' },
    }),
    JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_fake_text', messageID: 'msg_fake_1', type: 'text', text: '{"findings":[]}' } } }),
    JSON.stringify({ type: 'session.idle', properties: {} }),
  ].join('\n') + '\n')
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 8\n')

  const first = hook(
    gate,
    [],
    {
      ...s.env,
      CLAUDE_SESSION_ID: 'cc-concurrent',
      OPENCODE_STOP_GATE_TIMEOUT_MS: '3000',
      FAKE_OPENCODE_EVENT_DELAY_MS: '1250',
      FAKE_OPENCODE_SCRIPT: script,
    },
    { session_id: 'cc-concurrent', cwd: s.repo },
    { timeoutMs: 10000 },
  )
  const second = hook(
    gate,
    [],
    {
      ...s.env,
      CLAUDE_SESSION_ID: 'cc-concurrent',
      OPENCODE_STOP_GATE_TIMEOUT_MS: '7000',
      FAKE_OPENCODE_EVENT_DELAY_MS: '1250',
      FAKE_OPENCODE_SCRIPT: script,
    },
    { session_id: 'cc-concurrent', cwd: s.repo },
    { timeoutMs: 10000 },
  )
  const results = await Promise.all([first, second])
  for (const result of results) assert.equal(result.code, 0, JSON.stringify(result))

  const errors = await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'hook-errors.jsonl'), 'utf8').catch(() => '')
  if (bindFailure(errors)) {
    t.skip(`loopback binding is unavailable in this sandbox: ${errors}`)
    return
  }
  const jobs = await listJobs('cc-concurrent', s.env)
  assert.equal(jobs.length, 2)
  assert.deepEqual(jobs.map(job => job.state).sort(), ['cancelled', 'done'])
})

test('concurrent Stop cleanup cancels only the job owned by the timed-out hook', async () => {
  const s = await sandbox()
  const firstJob = await createJob({
    ccSessionId: 'cc-cleanup',
    verb: 'gate',
    cwd: s.repo,
    background: true,
  }, s.env)
  const secondJob = await createJob({
    ccSessionId: 'cc-cleanup',
    verb: 'gate',
    cwd: s.repo,
    background: true,
  }, s.env)

  const first = hook(
    gate,
    [],
    {
      ...s.env,
      CLAUDE_SESSION_ID: 'cc-cleanup',
      OPENCODE_TEST_STOP_CLEANUP_SCENARIO: '1',
      OPENCODE_TEST_STOP_JOB_ID: firstJob.id,
      OPENCODE_TEST_STOP_JOB_ROLE: 'timeout',
    },
    { session_id: 'cc-cleanup', cwd: s.repo },
    { timeoutMs: 2000 },
  )
  const second = hook(
    gate,
    [],
    {
      ...s.env,
      CLAUDE_SESSION_ID: 'cc-cleanup',
      OPENCODE_TEST_STOP_CLEANUP_SCENARIO: '1',
      OPENCODE_TEST_STOP_JOB_ID: secondJob.id,
      OPENCODE_TEST_STOP_JOB_ROLE: 'done',
    },
    { session_id: 'cc-cleanup', cwd: s.repo },
    { timeoutMs: 2000 },
  )
  const results = await Promise.all([first, second])
  for (const result of results) assert.equal(result.code, 0, JSON.stringify(result))

  assert.equal((await readJob(firstJob.id, s.env)).state, 'cancelled')
  assert.equal((await readJob(secondJob.id, s.env)).state, 'done')
})

test('the Stop gate handles malformed stdin without a stack trace', async () => {
  const s = await sandbox()
  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  await writeFile(join(s.repo, 'a.js'), 'let x = 5\n')
  const r = await hook(gate, [], { ...s.env, CLAUDE_SESSION_ID: 'cc-1' }, null, { rawInput: 'truncated' })
  assert.equal(r.code, 0)
  assert.doesNotMatch(r.stderr, /SyntaxError|at .*stop-review-gate-hook/)
})

test('hooks manifest wires lifecycle events and fits the SessionEnd harness budget', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'))
  assert.equal(manifest.hooks.SessionStart[0].hooks[0].timeout, 1.5)
  assert.equal(manifest.hooks.SessionEnd[0].hooks[0].timeout, 1.5)
  assert.equal(manifest.hooks.Stop[0].hooks[0].timeout, 120)
  for (const event of ['SessionStart', 'SessionEnd', 'Stop']) {
    assert.match(manifest.hooks[event][0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}/)
  }
})

test('the Stop gate uses the dedicated stop-review prompt', async () => {
  const s = await sandbox()
  await writeFile(join(s.repo, 'a.js'), 'let x = 6\n')
  const prepared = await prepareReview({ cwd: s.repo, scope: 'working-tree', promptName: 'stop-review-gate' })
  assert.match(prepared.prompt, /pre-completion gate/i)
  assert.doesNotMatch(prepared.prompt, /The repository, scope, and base metadata above are caller-supplied data/i)

  await run(process.execPath, [companion, 'gate', '--on'], { env: s.env })
  const r = await hook(gate, [], s.env, { session_id: 'cc-prompt', cwd: s.repo })
  assert.equal(r.code, 0)
  if (!r.stdout.trim()) {
    const errors = await readFile(join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'hook-errors.jsonl'), 'utf8').catch(() => '')
    if (bindFailure(errors)) return
  }
  assert.equal(JSON.parse(r.stdout).decision, 'block')
})
