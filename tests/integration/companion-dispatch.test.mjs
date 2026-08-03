import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../scripts/lib/process.mjs'
import { main, handlers } from '../../scripts/opencode-companion.mjs'

const companion = fileURLToPath(new URL('../../scripts/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const bindFailure = (detail) => /EACCES|EPERM|EADDRNOTAVAIL|loopback|listen/i.test(String(detail))

async function env(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'occli-'))
  const e = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-test',
    ...extra,
  }
  await mkdir(join(e.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(e.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  await writeFile(join(e.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  await writeFile(join(e.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), '{"model":"openrouter/x"}')
  return { env: e, home }
}

test('--help exits 0 and lists the verbs that exist now', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, '--help'], { env: e.env })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\bdoctor\b/)
})

test('no arguments exits 0 with usage', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion], { env: e.env })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /opencode-companion\.mjs <verb>/)
  assert.equal(r.stderr, '')
})

test('an unknown verb exits 2 with usage on stderr', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'frobnicate'], { env: e.env })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown verb: frobnicate/)
  assert.match(r.stderr, /\bdoctor\b/)
  assert.equal(r.stdout, '')
})

test('an unknown verb followed by --help still exits 2', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'frobnicate', '--help'], { env: e.env })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown verb: frobnicate/)
  assert.equal(r.stdout, '')
})

test('doctor rejects an unknown flag', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'doctor', '--not-a-real-flag'], { env: e.env })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown flag --not-a-real-flag/)
  assert.equal(r.stdout, '')
})

test('doctor rejects an unexpected positional argument', async () => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'doctor', 'whatever'], { env: e.env })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unexpected positional argument "whatever"/)
  assert.equal(r.stdout, '')
})

test('a missing handler result is a crash, not silent success', async () => {
  const e = await env()
  const original = handlers.doctor
  handlers.doctor = async () => undefined
  try {
    assert.equal(await main(['doctor'], e.env, e.home), 3)
  } finally {
    handlers.doctor = original
  }
})

test('doctor --json emits a parseable report and exits 0 when ready', async (t) => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'doctor', '--json'], { env: e.env })
  const report = JSON.parse(r.stdout)
  if (!report.ok && bindFailure(report.server?.detail)) {
    t.skip(`loopback binding is unavailable in this sandbox: ${report.server.detail}`)
    return
  }
  assert.equal(r.code, 0)
  assert.equal(report.ok, true)
  assert.equal(report.model.value, 'openrouter/x')
  assert.equal(r.stderr, '')
})

test('doctor --json exits 1 but still emits only the report when a gap exists', async () => {
  const e = await env({ OPENCODE_BIN: '/nonexistent/opencode', PATH: '/nonexistent' })
  const r = await run(process.execPath, [companion, 'doctor', '--json'], { env: e.env })
  assert.equal(r.code, 1)
  const report = JSON.parse(r.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.gaps.length > 0)
  assert.equal(r.stderr, '')
})

test('doctor without --json renders a readable table', async (t) => {
  const e = await env()
  const r = await run(process.execPath, [companion, 'doctor'], { env: e.env })
  if (bindFailure(r.stdout)) {
    t.skip('loopback binding is unavailable in this sandbox')
    return
  }
  assert.match(r.stdout, /opencode doctor/)
  assert.match(r.stdout, /binary/)
  assert.match(r.stdout, /All checks passed/)
})

test('a doctor gap is reported on stdout and points at setup', async () => {
  const e = await env({ OPENCODE_BIN: '/nonexistent/opencode', PATH: '/nonexistent' })
  const r = await run(process.execPath, [companion, 'doctor'], { env: e.env })
  assert.equal(r.code, 1)
  assert.match(r.stdout, /Run \/opencode:setup/)
  assert.equal(r.stderr, '')
})
