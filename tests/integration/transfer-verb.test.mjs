import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/lib/process.mjs'
import { readEndpoint } from '../../src/lib/broker-endpoint.mjs'
import { readJson, sessionsDir } from '../../src/lib/state.mjs'
import { rememberOpencodeSession } from '../../src/lib/tracked-jobs.mjs'
import { ccSessionId, handlers } from '../../src/opencode-companion.mjs'

const companion = fileURLToPath(new URL('../../src/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

async function persistedSession(s) {
  return readJson(
    join(sessionsDir(s.env), `${encodeURIComponent(ccSessionId(s.env))}.json`),
    null,
  )
}

function withoutSessionEnv(env) {
  const copy = { ...env }
  delete copy.CLAUDE_SESSION_ID
  delete copy.CLAUDE_CODE_SESSION_ID
  return copy
}

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'octrans-'))
  const transcript = join(home, 't.jsonl')
  await writeFile(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'port the parser to the new API' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I started on lib/parse.js' }] } }),
  ].join('\n'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-face',
    CLAUDE_TRANSCRIPT_PATH: transcript,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env, home, transcript }
}

function skipBindFailure(t, result) {
  if (!isBindFailure(result)) return false
  t.skip(`loopback binding is unavailable in this sandbox: ${result.stderr}`)
  return true
}

function isBindFailure(result) {
  return result.code === 1 && /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(result.stderr)
}

async function stubbedPartialTransfer(s) {
  try {
    await handlers.transfer({
      flags: {},
      env: s.env,
      cwd: s.home,
      ccSessionId: s.env.CLAUDE_SESSION_ID,
      runDoctorFn: async () => ({
        binary: { ok: true },
        version: { ok: true },
        auth: { ok: true },
        model: { ok: true },
        gaps: [],
      }),
      addRefFn: async () => {},
      releaseRefFn: async () => {},
      ensureBrokerFn: async () => ({
        client: {
          createSession: async () => ({ id: 'ses_stub' }),
          promptAsync: async () => {},
        },
      }),
      rememberOpencodeSessionFn: rememberOpencodeSession,
    })
    assert.fail('stubbed partial transfer unexpectedly succeeded')
  } catch (error) {
    return error
  }
}

async function stubbedSuccessfulTransfer(s, env) {
  return handlers.transfer({
    flags: {},
    env,
    cwd: s.home,
    ccSessionId: ccSessionId(env),
    runDoctorFn: async () => ({
      binary: { ok: true },
      version: { ok: true },
      auth: { ok: true },
      model: { ok: true },
      gaps: [],
    }),
    addRefFn: async () => {},
    releaseRefFn: async () => {},
    ensureBrokerFn: async () => ({
      client: {
        createSession: async () => ({ id: 'ses_stub' }),
        promptAsync: async () => {},
      },
    }),
    rememberOpencodeSessionFn: rememberOpencodeSession,
  })
}

test('transfer writes a handoff, creates a session, and prints the resume command', async (t) => {
  const s = await sandbox()
  const r = await run(process.execPath, [companion, 'transfer'], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0, r.stderr)
  const sessionMatch = r.stdout.match(/opencode --session (ses_\S+)/)
  assert.ok(sessionMatch, r.stdout)
  const pathMatch = r.stdout.match(/(\S+\.md)/)
  assert.ok(pathMatch)
  const handoff = await readFile(pathMatch[1], 'utf8')
  assert.match(handoff, /port the parser/)
  assert.match(handoff, /lib\/parse\.js/)
  assert.match(r.stdout, /one-way/i)
  assert.match(r.stdout, /no secret redaction/i)
  const record = await persistedSession(s)
  assert.equal(record?.ccSessionId, s.env.CLAUDE_SESSION_ID)
  assert.equal(record?.lastOpencodeSession, sessionMatch[1])
  assert.equal(await readEndpoint(s.env), null)
})

test('transfer without session env uses a valid fallback with an explicit transcript', async () => {
  const s = await sandbox()
  const env = withoutSessionEnv(s.env)
  const cliResult = await run(process.execPath, [companion, 'transfer'], { env, cwd: s.home, timeoutMs: 60000 })
  const fallback = isBindFailure(cliResult) ? await stubbedSuccessfulTransfer(s, env) : null
  const r = fallback
    ? { code: fallback.exitCode, stdout: fallback.stdout, stderr: '' }
    : cliResult
  assert.equal(r.code, 0, r.stderr)
  const sessionMatch = r.stdout.match(/(?:opencode --session|Seeded opencode session: )?(ses_\S+)/)
  assert.ok(sessionMatch, r.stdout)
  const pathMatch = r.stdout.match(/(\S+\.md)/)
  assert.ok(pathMatch)
  assert.match(pathMatch[1], /\/transfers\/0-\d+\.md$/)
  const handoff = await readFile(pathMatch[1], 'utf8')
  assert.match(handoff, /port the parser/)
  assert.match(handoff, /Claude Code session: 0/)
  const record = await persistedSession({ ...s, env })
  assert.equal(record?.ccSessionId, '0')
  assert.equal(record?.lastOpencodeSession, sessionMatch[1])
  assert.equal(await readEndpoint(env), null)
})

test('transfer refuses an unsafe Claude Code session id before discovery or setup', async () => {
  const s = await sandbox()
  const env = { ...s.env, CLAUDE_SESSION_ID: '../outside' }
  const r = await run(process.execPath, [companion, 'transfer'], { env, cwd: s.home, timeoutMs: 60000 })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /invalid Claude Code session id/i)
  assert.equal(r.stdout, '')
  assert.equal(await persistedSession({ ...s, env }), null)
})

test('transfer --out writes to the requested path', async (t) => {
  const s = await sandbox()
  const out = join(s.home, 'handoff.md')
  const r = await run(process.execPath, [companion, 'transfer', '--out', out], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0, r.stderr)
  assert.match(await readFile(out, 'utf8'), /port the parser/)
  const record = await persistedSession(s)
  assert.equal(record?.ccSessionId, s.env.CLAUDE_SESSION_ID)
  assert.match(record?.lastOpencodeSession ?? '', /^ses_/)
  assert.equal(await readEndpoint(s.env), null)
})

test('transfer --out remains an explicit caller-supplied path outside session containment', async () => {
  const s = await sandbox()
  const out = join(s.home, 'caller-out.md')
  const result = await handlers.transfer({
    flags: { out },
    env: s.env,
    cwd: s.home,
    ccSessionId: s.env.CLAUDE_SESSION_ID,
    runDoctorFn: async () => ({
      binary: { ok: true },
      version: { ok: true },
      auth: { ok: true },
      model: { ok: true },
      gaps: [],
    }),
    addRefFn: async () => {},
    releaseRefFn: async () => {},
    ensureBrokerFn: async () => ({
      client: {
        createSession: async () => ({ id: 'ses_out' }),
        promptAsync: async () => {},
      },
    }),
    rememberOpencodeSessionFn: rememberOpencodeSession,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.startsWith(`Handoff written to ${out}`), true)
  assert.match(await readFile(out, 'utf8'), /port the parser/)
})

test('transfer without a findable transcript still produces a handoff and says so', async (t) => {
  const s = await sandbox()
  const env = { ...s.env, CLAUDE_TRANSCRIPT_PATH: join(s.home, 'missing.jsonl') }
  const r = await run(process.execPath, [companion, 'transfer'], { env, cwd: s.home, timeoutMs: 60000 })
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /could not be located/i)
  assert.match(r.stdout, /ses_/)
  const record = await persistedSession({ ...s, env })
  assert.equal(record?.ccSessionId, env.CLAUDE_SESSION_ID)
  assert.match(record?.lastOpencodeSession ?? '', /^ses_/)
  assert.equal(await readEndpoint(env), null)
})

test('transfer without session env and without a transcript still writes the fallback handoff', async () => {
  const s = await sandbox()
  const env = withoutSessionEnv(s.env)
  delete env.CLAUDE_TRANSCRIPT_PATH
  const cliResult = await run(process.execPath, [companion, 'transfer'], { env, cwd: s.home, timeoutMs: 60000 })
  const fallback = isBindFailure(cliResult) ? await stubbedSuccessfulTransfer(s, env) : null
  const r = fallback
    ? { code: fallback.exitCode, stdout: fallback.stdout, stderr: '' }
    : cliResult
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /could not be located/i)
  assert.match(r.stdout, /Handoff written to \S+\/transfers\/0-\d+\.md/)
  assert.match(r.stdout, /Seeded opencode session: ses_/)
  const record = await persistedSession({ ...s, env })
  assert.equal(record?.ccSessionId, '0')
  assert.match(record?.lastOpencodeSession ?? '', /^ses_/)
  assert.equal(await readEndpoint(env), null)
})

test('task-resume-candidate remains usable without session environment variables', async () => {
  const s = await sandbox()
  const env = withoutSessionEnv(s.env)
  const r = await run(process.execPath, [companion, 'task-resume-candidate', '--json'], { env, cwd: s.home, timeoutMs: 60000 })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), {
    hasCandidate: false,
    sessionID: null,
    lastVerb: null,
    lastEndedAt: null,
  })
})

test('transfer reports a malformed transcript as a partial gap and keeps valid context', async () => {
  const s = await sandbox()
  await writeFile(s.transcript, [
    'not json',
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'keep this turn' } }),
  ].join('\n'))
  const r = await run(process.execPath, [companion, 'transfer'], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  if (isBindFailure(r)) {
    const error = await stubbedPartialTransfer(s)
    assert.equal(error?.exitCode, 1)
    assert.match(error?.message ?? '', /malformed|partial/i)
    assert.match(error?.message ?? '', /keep valid context|handoff/i)
    const handoffPath = error?.message.match(/Handoff written to (\S+\.md)/)?.[1]
    assert.ok(handoffPath, error?.message)
    assert.match(await readFile(handoffPath, 'utf8'), /keep this turn/)
    const sessionMatch = error?.message.match(/Seeded opencode session: (ses_\S+?)(?:\.|$)/)
    assert.ok(sessionMatch, error?.message)
    const record = await persistedSession(s)
    assert.equal(record?.ccSessionId, s.env.CLAUDE_SESSION_ID)
    assert.equal(record?.lastOpencodeSession, sessionMatch[1])
    assert.equal(await readEndpoint(s.env), null)
    return
  }
  assert.equal(r.code, 1)
  assert.match(r.stderr, /malformed|partial/i)
  assert.match(r.stderr, /keep valid context|handoff/i)
  const handoffPath = r.stderr.match(/Handoff written to (\S+\.md)/)?.[1]
  assert.ok(handoffPath, r.stderr)
  assert.match(await readFile(handoffPath, 'utf8'), /keep this turn/)
  const sessionMatch = r.stderr.match(/Seeded opencode session: (ses_\S+?)(?:\.|$)/)
  assert.ok(sessionMatch, r.stderr)
  const record = await persistedSession(s)
  assert.equal(record?.ccSessionId, s.env.CLAUDE_SESSION_ID)
  assert.equal(record?.lastOpencodeSession, sessionMatch[1])
  assert.equal(await readEndpoint(s.env), null)
})

test('transfer refuses an unreadable transcript and does not create a session', async () => {
  const s = await sandbox()
  const env = { ...s.env, CLAUDE_TRANSCRIPT_PATH: s.home }
  const r = await run(process.execPath, [companion, 'transfer'], { env, cwd: s.home, timeoutMs: 60000 })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /could not read|unreadable|EISDIR/i)
  assert.match(r.stderr, /Handoff metadata written to \S+\.md/)
  assert.doesNotMatch(r.stdout, /opencode --session/)
  assert.equal(await persistedSession({ ...s, env }), null)
  assert.equal(await readEndpoint(env), null)
})

test('transfer refuses an empty transcript with a distinct gap', async () => {
  const s = await sandbox()
  await writeFile(s.transcript, '')
  const r = await run(process.execPath, [companion, 'transfer'], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /empty|no conversation content/i)
  assert.match(r.stderr, /Handoff written to \S+\.md/)
  assert.doesNotMatch(r.stdout, /opencode --session/)
  assert.equal(await persistedSession(s), null)
  assert.equal(await readEndpoint(s.env), null)
})
