import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'
import { readEndpoint } from '../../scripts/lib/broker-endpoint.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

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
    CLAUDE_SESSION_ID: 'cc-transfer',
    CLAUDE_TRANSCRIPT_PATH: transcript,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env, home, transcript }
}

function skipBindFailure(t, result) {
  if (result.code !== 1 || !/EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(result.stderr)) return false
  t.skip(`loopback binding is unavailable in this sandbox: ${result.stderr}`)
  return true
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
  assert.equal(await readEndpoint(s.env), null)
})

test('transfer --out writes to the requested path', async (t) => {
  const s = await sandbox()
  const out = join(s.home, 'handoff.md')
  const r = await run(process.execPath, [companion, 'transfer', '--out', out], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0, r.stderr)
  assert.match(await readFile(out, 'utf8'), /port the parser/)
  assert.equal(await readEndpoint(s.env), null)
})

test('transfer without a findable transcript still produces a handoff and says so', async (t) => {
  const s = await sandbox()
  const env = { ...s.env, CLAUDE_TRANSCRIPT_PATH: join(s.home, 'missing.jsonl') }
  const r = await run(process.execPath, [companion, 'transfer'], { env, cwd: s.home, timeoutMs: 60000 })
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /could not be located/i)
  assert.match(r.stdout, /ses_/)
  assert.equal(await readEndpoint(env), null)
})

test('transfer reports a malformed transcript as a partial gap and keeps valid context', async (t) => {
  const s = await sandbox()
  await writeFile(s.transcript, [
    'not json',
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'keep this turn' } }),
  ].join('\n'))
  const r = await run(process.execPath, [companion, 'transfer'], { env: s.env, cwd: s.home, timeoutMs: 60000 })
  if (skipBindFailure(t, r)) return
  assert.equal(r.code, 1)
  assert.match(r.stderr, /malformed|partial/i)
  assert.match(r.stderr, /keep valid context|handoff/i)
  const handoffPath = r.stderr.match(/Handoff written to (\S+\.md)/)?.[1]
  assert.ok(handoffPath, r.stderr)
  assert.match(await readFile(handoffPath, 'utf8'), /keep this turn/)
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
  assert.equal(await readEndpoint(s.env), null)
})
