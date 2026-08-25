import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/lib/process.mjs'

const companion = fileURLToPath(new URL('../../src/opencode-companion.mjs', import.meta.url))
const realBin = process.env.OPENCODE_BIN || join(homedir(), '.opencode', 'bin', 'opencode')

const haveRealBinary = await access(realBin).then(() => true, () => false)
const loopbackAvailable = await new Promise((resolve) => {
  const server = createServer()
  server.once('error', () => resolve(false))
  server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
})
const sandboxes = new Set()

// A throwaway HOME with no auth.json and no opencode.json — the developer's real
// credentials are never touched by this suite.
async function isolated(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ociso-'))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: realBin,
    CLAUDE_SESSION_ID: 'cc-iso',
    ...extra,
  }
  await mkdir(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  const sandbox = { env, home }
  sandboxes.add(sandbox)
  return sandbox
}

const cli = (env, args, cwd) => run(process.execPath, [companion, ...args], { env, cwd, timeoutMs: 120000 })
const warn = (message) => {
  try {
    process.stderr.write(`${message}\n`)
  } catch {
    // Cleanup warnings must never turn into a test failure.
  }
}

afterEach(async () => {
  const pending = [...sandboxes]
  sandboxes.clear()
  for (const sandbox of pending) {
    // Repair is scoped to this sandbox's owner/endpoint records. It is the
    // failure-path cleanup for any broker the test may have started.
    let repair
    try {
      repair = await cli(sandbox.env, ['repair'])
    } catch (error) {
      warn(
        `[isolated cleanup] retained home ${sandbox.home}; `
        + `repair exit code: unavailable (repair threw); `
        + `repair stderr: ${typeof error?.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : '(unavailable)'}; `
        + `error: ${error?.message ?? String(error)}`,
      )
      continue
    }

    if (repair.code !== 0) {
      warn(
        `[isolated cleanup] retained home ${sandbox.home}; `
        + `repair exit code: ${repair.code}; `
        + `repair stderr: ${repair.stderr.trim() || '(empty)'}`,
      )
      continue
    }

    try {
      await rm(sandbox.home, { recursive: true, force: true })
    } catch (error) {
      warn(
        `[isolated cleanup] retained home ${sandbox.home}; `
        + 'repair exit code: 0; '
        + `repair stderr: ${repair.stderr.trim() || '(empty)'}; `
        + `home removal failed: ${error?.message ?? String(error)}`,
      )
    }
  }
})

test('fresh install: doctor names the auth gap against the real binary', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  const r = await cli(s.env, ['doctor', '--json'])
  const report = JSON.parse(r.stdout)
  assert.equal(report.binary.ok, true)
  assert.equal(report.version.ok, true, `version ${report.version.value} is below the floor`)
  assert.equal(report.auth.ok, false)
  assert.match(report.gaps.join(' '), /credentials/)
})

test('auth present, model missing: exactly one gap, and it names the model', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-placeholder' } }), { mode: 0o600 })
  const r = await cli(s.env, ['doctor', '--json', '--no-server'])
  const report = JSON.parse(r.stdout)
  assert.equal(report.auth.ok, true)
  assert.equal(report.model.ok, false)
  assert.deepEqual(report.gaps.filter(g => /model/.test(g)).length, 1)
})

test('set-key writes a real auth.json at 0600 without clobbering siblings', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  const authPath = join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'KEEP' } }), { mode: 0o600 })
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-test1234'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout.includes('sk-or-test1234'), false)
  const out = JSON.parse(await readFile(authPath, 'utf8'))
  assert.equal(out.anthropic.key, 'KEEP')
  assert.equal(out.openrouter.key, 'sk-or-test1234')
  assert.equal((await stat(authPath)).mode & 0o777, 0o600)
})

test('set-model writes a real config and doctor confirms it on re-run', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-placeholder' } }), { mode: 0o600 })
  const set = await cli(s.env, ['set-model', '--model', 'openrouter/openai/gpt-oss-20b:free'])
  assert.equal(set.code, 0, set.stderr)
  const report = JSON.parse((await cli(s.env, ['doctor', '--json', '--no-server'])).stdout)
  assert.equal(report.model.ok, true)
  assert.equal(report.model.source, 'global')
})

test('a model whose provider has no credential still leaves setup a path forward', { skip: !haveRealBinary && 'no real opencode binary' }, async () => {
  const s = await isolated()
  await cli(s.env, ['set-model', '--model', 'anthropic/claude-sonnet-5'])
  const report = JSON.parse((await cli(s.env, ['doctor', '--json', '--no-server'])).stdout)
  assert.equal(report.model.ok, true)
  assert.equal(report.auth.ok, false)
  assert.match(report.gaps.join(' '), /credentials/)
})

test('the real server starts and answers the doctor server check', {
  skip: !haveRealBinary
    ? 'no real opencode binary'
    : !loopbackAvailable && 'loopback is unavailable in this environment',
}, async () => {
  const s = await isolated()
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: 'sk-placeholder' } }), { mode: 0o600 })
  const set = await cli(s.env, ['set-model', '--model', 'openrouter/openai/gpt-oss-20b:free'])
  assert.equal(set.code, 0, set.stderr)
  const report = JSON.parse((await cli(s.env, ['doctor', '--json'])).stdout)
  assert.equal(report.server.ok, true, report.server.detail)
  const repaired = await cli(s.env, ['repair'])
  assert.equal(repaired.code, 0, repaired.stderr)
})
