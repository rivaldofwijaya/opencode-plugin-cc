import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAlive, run, terminate } from '../../src/lib/process.mjs'
import { readEndpoint, writeEndpoint } from '../../src/lib/broker-endpoint.mjs'
import { brokerDir, readJson, writeJson } from '../../src/lib/state.mjs'
import { ensureBroker } from '../../src/lib/broker-lifecycle.mjs'
import { withFakeOwnedBroker } from '../helpers/process-cleanup.mjs'
import { handlers } from '../../src/opencode-companion.mjs'

const companion = fileURLToPath(new URL('../../src/opencode-companion.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const sandboxes = new Set()

afterEach(async () => {
  const roots = [...sandboxes]
  try {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  } finally {
    sandboxes.clear()
  }
})

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ocsetup-'))
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_BIN: fixture,
    CLAUDE_SESSION_ID: 'cc-setup',
    ...extra,
  }
  await mkdir(join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true })
  sandboxes.add(home)
  return { env, home }
}

const cli = (env, args, cwd) => run(process.execPath, [companion, ...args], { env, cwd })

const invokeModels = (s, flags, invocations) => handlers.models({
  flags,
  env: s.env,
  resolveBinaryFn: async () => ({ path: fixture }),
  runFn: async (...args) => {
    invocations.push(args)
    return run(...args)
  },
})

test('set-key writes auth.json at 0600 and prints only a redacted confirmation', async () => {
  const s = await sandbox()
  const rawKey = 'sk-or-abcd1234'
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', rawKey])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /\*\*\*\*1234/)
  assert.equal(r.stdout.includes(rawKey), false)
  assert.equal(r.stderr.includes(rawKey), false)
  const p = join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  assert.equal(JSON.parse(await readFile(p, 'utf8')).openrouter.key, 'sk-or-abcd1234')
  assert.equal((await stat(p)).mode & 0o777, 0o600)
})

test('set-key preserves an existing provider', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"anthropic":{"type":"api","key":"KEEP"}}')
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-wxyz9876'])
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'))
  assert.equal(out.anthropic.key, 'KEEP')
  assert.deepEqual(out.openrouter, { type: 'api', key: 'sk-or-wxyz9876' })
  assert.match(r.stdout, /Backed up the previous file to .*auth\.json\.bak\./)
})

test('set-key without a key reports invalid invocation with a clear message', async () => {
  const s = await sandbox()
  const dataHome = s.env.XDG_DATA_HOME
  const dataDir = join(dataHome, 'opencode')
  const auth = join(dataDir, 'auth.json')
  const backup = `${auth}.bak`
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter'])
  assert.equal(r.code, 2)
  assert.equal(r.stderr.trim(), 'set-key requires --key <API_KEY>')
  assert.equal(r.stdout, '')
  await assert.rejects(() => stat(dataHome), { code: 'ENOENT' })
  await assert.rejects(() => stat(dataDir), { code: 'ENOENT' })
  await assert.rejects(() => stat(auth), { code: 'ENOENT' })
  await assert.rejects(() => stat(backup), { code: 'ENOENT' })

  const valid = await sandbox()
  const accepted = await cli(valid.env, [
    'set-key', '--provider', 'openrouter', '--key', 'sk-or-valid-control',
  ])
  assert.equal(accepted.code, 0)
  assert.equal(
    JSON.parse(await readFile(join(valid.env.XDG_DATA_HOME, 'opencode', 'auth.json')))
      .openrouter.key,
    'sk-or-valid-control',
  )
})

test('set-key reports a sanitized underlying filesystem error code', async () => {
  const control = await sandbox()
  const controlKey = 'sk-or-control-2468'
  const controlResult = await cli(control.env, [
    'set-key', '--provider', 'control-provider', '--key', controlKey,
  ])
  assert.equal(controlResult.code, 0)
  assert.equal(
    JSON.parse(await readFile(join(control.env.XDG_DATA_HOME, 'opencode', 'auth.json')))
      ['control-provider'].key,
    controlKey,
  )

  const s = await sandbox()
  const dataDir = join(s.env.XDG_DATA_HOME, 'opencode')
  const auth = join(dataDir, 'auth.json')
  await mkdir(dataDir, { recursive: true })
  await mkdir(auth)
  const before = await stat(auth)
  const beforeEntries = await readdir(auth)
  const r = await cli(s.env, ['set-key', '--provider', 'openrouter', '--key', 'sk-or-neverprint'])
  assert.equal(r.code, 1)
  assert.equal(r.stderr.trim(), 'set-key failed (EISDIR)')
  assert.equal(r.stdout.includes('sk-or-neverprint'), false)
  assert.equal(r.stderr.includes('sk-or-neverprint'), false)
  const after = await stat(auth)
  assert.equal(after.isDirectory(), true)
  assert.equal(after.mode & 0o777, before.mode & 0o777)
  assert.deepEqual(await readdir(auth), beforeEntries)
  await assert.rejects(() => stat(auth + '.bak'), { code: 'ENOENT' })
  assert.deepEqual(await readdir(dataDir), ['auth.json'])

  const existing = await sandbox()
  const existingDataDir = join(existing.env.XDG_DATA_HOME, 'opencode')
  const existingAuth = join(existingDataDir, 'auth.json')
  const existingBackup = existingAuth + '.bak'
  const original = '{"anthropic":{"type":"api","key":"KEEP"}}\n'
  await mkdir(existingDataDir, { recursive: true })
  await writeFile(existingAuth, original)
  await chmod(existingAuth, 0o640)
  await mkdir(existingBackup)
  const existingBefore = await stat(existingAuth)
  const backupBefore = await stat(existingBackup)
  const existingResult = await cli(existing.env, [
    'set-key', '--provider', 'openrouter', '--key', 'sk-or-existing-neverprint',
  ])
  assert.equal(existingResult.code, 1)
  assert.equal(existingResult.stderr.trim(), 'set-key failed (EISDIR)')
  assert.equal(existingResult.stdout.includes('sk-or-existing-neverprint'), false)
  assert.equal(existingResult.stderr.includes('sk-or-existing-neverprint'), false)
  assert.equal(await readFile(existingAuth, 'utf8'), original)
  assert.equal((await stat(existingAuth)).mode & 0o777, existingBefore.mode & 0o777)
  assert.equal((await stat(existingBackup)).isDirectory(), true)
  assert.equal((await stat(existingBackup)).mode & 0o777, backupBefore.mode & 0o777)
  assert.deepEqual(await readdir(existingDataDir), ['auth.json', 'auth.json.bak'])
})

test('set-model merges into the existing global .jsonc, reports comments dropped, and re-runs doctor', async () => {
  const s = await sandbox()
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json'), '{"openrouter":{"type":"api","key":"k"}}')
  const cfg = join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc')
  await writeFile(cfg, '{\n  // keep\n  "theme": "dark"\n}')
  const r = await cli(s.env, ['set-model', '--model', 'openrouter/x'])
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(cfg, 'utf8'))
  assert.equal(out.theme, 'dark')
  assert.equal(out.model, 'openrouter/x')
  assert.match(r.stdout, /Backed up the previous file to .*opencode\.jsonc\.bak\./)
  assert.match(r.stdout, /comments were dropped/i)
  assert.match(r.stdout, /opencode doctor/)
})

test('set-model --scope project writes into the working directory', async () => {
  const s = await sandbox()
  const r = await cli(s.env, ['set-model', '--model', 'openrouter/y', '--scope', 'project'], s.home)
  assert.equal(r.code, 0)
  const out = JSON.parse(await readFile(join(s.home, 'opencode.json'), 'utf8'))
  assert.equal(out.model, 'openrouter/y')
  assert.equal(out.$schema, 'https://opencode.ai/config.json')
})

test('set-model rejects malformed provider/model values before writing', async () => {
  const cases = [
    ['justamodel', /missing the provider\/model slash/],
    ['', /it is empty/],
    ['   ', /only whitespace/],
    ['/model', /leading slash/],
    ['provider/', /trailing slash/],
    ['provider//model', /consecutive slashes/],
  ]

  for (const [model, reason] of cases) {
    const s = await sandbox()
    const r = await cli(s.env, ['set-model', '--model', model])
    assert.equal(r.code, 2, model || '(empty)')
    assert.match(r.stderr, reason)
    assert.match(r.stderr, /expected provider\/model form/)
    await assert.rejects(() => stat(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')))
    await assert.rejects(() => stat(join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc')))
  }
})

test('models lists what the binary reports and filters by provider', async () => {
  const s = await sandbox({ FAKE_OPENCODE_MODELS: 'a/one,a/two,b/three' })
  const configuredModels = s.env.FAKE_OPENCODE_MODELS.split(',').map(model => model.trim()).filter(Boolean)
  const invocations = []
  const all = await invokeModels(s, {}, invocations)
  assert.equal(all.exitCode, 0)
  assert.deepEqual(all.stdout.split('\n'), configuredModels)
  const provider = configuredModels[0].split('/')[0]
  const filtered = await invokeModels(s, { provider }, invocations)
  assert.equal(filtered.exitCode, 0)
  assert.deepEqual(
    filtered.stdout.split('\n'),
    configuredModels.filter(model => model.startsWith(`${provider}/`)),
  )
  assert.equal(invocations.length, 2)
  assert.ok(invocations.every(([path, args, options]) => (
    path === fixture && args[0] === 'models' && options.env === s.env
  )))
})

test('models reports binary failures on stderr with a non-zero exit', async () => {
  const s = await sandbox({
    FAKE_OPENCODE_FAULT: 'partial-then-fail',
    FAKE_OPENCODE_MODELS: 'stale/model',
  })
  const r = await cli(s.env, ['models'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /opencode models failed for .*fake opencode failed/i)
  assert.equal(r.stdout, '')

  let invocation
  await assert.rejects(
    () => handlers.models({
      flags: {},
      env: s.env,
      resolveBinaryFn: async () => ({ path: fixture }),
      runFn: async (...args) => {
        invocation = args
        return run(...args)
      },
    }),
    error => {
      assert.equal(error.exitCode, 1)
      assert.match(error.message, /opencode models failed for .*fake opencode failed/i)
      return true
    },
  )
  assert.ok(invocation)
  assert.equal(invocation[0], fixture)
  assert.deepEqual(invocation[1], ['models'])
  assert.equal(invocation[2].env, s.env)
})

test('models reports a missing binary as a gap', async () => {
  const s = await sandbox({
    OPENCODE_BIN: '/nonexistent/opencode',
    PATH: '/nonexistent',
  })
  const r = await cli(s.env, ['models'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /opencode binary unavailable: opencode binary not found/i)

  let resolutionRequest
  await assert.rejects(
    () => handlers.models({
      flags: {},
      env: s.env,
      resolveBinaryFn: async request => {
        resolutionRequest = request
        throw new Error('opencode binary not found')
      },
    }),
    error => {
      assert.equal(error.exitCode, 1)
      assert.match(error.message, /opencode binary unavailable: opencode binary not found/i)
      return true
    },
  )
  assert.ok(resolutionRequest)
  assert.equal(resolutionRequest.env, s.env)
})

test('models maps a spawn failure to a reported gap', async () => {
  const s = await sandbox()
  const spawnError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  let resolutionRequest
  let invocation
  await assert.rejects(
    () => handlers.models({
      flags: {},
      env: s.env,
      resolveBinaryFn: async request => {
        resolutionRequest = request
        return { path: '/tmp/unusable-opencode' }
      },
      runFn: async (...args) => {
        invocation = args
        throw spawnError
      },
    }),
    error => {
      assert.equal(error.exitCode, 1)
      assert.match(error.message, /opencode binary \/tmp\/unusable-opencode could not be started: permission denied/)
      return true
    },
  )
  assert.ok(resolutionRequest)
  assert.equal(resolutionRequest.env, s.env)
  assert.ok(invocation)
  assert.equal(invocation[0], '/tmp/unusable-opencode')
  assert.deepEqual(invocation[1], ['models'])
  assert.equal(invocation[2].env, s.env)
})

test('models explains empty and unmatched results', async () => {
  const empty = await sandbox({ FAKE_OPENCODE_MODELS: ',' })
  const emptyModels = empty.env.FAKE_OPENCODE_MODELS.split(',').map(model => model.trim()).filter(Boolean)
  const emptyInvocations = []
  const emptyResult = await invokeModels(empty, {}, emptyInvocations)
  assert.equal(emptyResult.exitCode, 0)
  assert.equal(
    emptyResult.stdout.trim(),
    emptyModels.length === 0
      ? 'The opencode binary reported no models at all.'
      : emptyModels.join('\n'),
  )
  assert.equal(emptyInvocations.length, 1)
  assert.equal(emptyInvocations[0][0], fixture)
  assert.deepEqual(emptyInvocations[0][1], ['models'])
  assert.equal(emptyInvocations[0][2].env, empty.env)

  const filtered = await sandbox({ FAKE_OPENCODE_MODELS: 'a/one,b/two' })
  const configuredModels = filtered.env.FAKE_OPENCODE_MODELS.split(',').map(model => model.trim()).filter(Boolean)
  const provider = 'z'
  const filteredInvocations = []
  const filteredResult = await invokeModels(filtered, { provider }, filteredInvocations)
  const matchingModels = configuredModels.filter(model => model.startsWith(`${provider}/`))
  assert.equal(filteredResult.exitCode, 0)
  assert.equal(
    filteredResult.stdout.trim(),
    matchingModels.length === 0
      ? `No models matched provider ${provider}.`
      : matchingModels.join('\n'),
  )
  assert.equal(filteredInvocations.length, 1)
  assert.equal(filteredInvocations[0][0], fixture)
  assert.deepEqual(filteredInvocations[0][1], ['models'])
  assert.equal(filteredInvocations[0][2].env, filtered.env)
})

test('set-key keeps its write report when the post-write doctor fails', async () => {
  const s = await sandbox()
  const auth = join(s.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  const original = '{"anthropic":{"type":"api","key":"KEEP"}}'
  await mkdir(join(s.env.XDG_DATA_HOME, 'opencode'), { recursive: true })
  await writeFile(auth, original)
  const result = await handlers['set-key']({
    flags: { provider: 'openrouter', key: 'sk-or-postwrite' },
    env: s.env,
    cwd: s.home,
    runDoctorFn: async () => { throw new Error('synthetic post-write failure') },
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /Stored a key for openrouter/)
  assert.match(result.stdout, /Backed up the previous file to .*auth\.json\.bak\./)
  assert.match(result.stdout, /Post-write doctor check failed: synthetic post-write failure/)
  assert.deepEqual(JSON.parse(await readFile(auth, 'utf8')).openrouter, {
    type: 'api',
    key: 'sk-or-postwrite',
  })
  assert.equal(await readFile(auth + '.bak', 'utf8'), original)
})

test('set-model keeps its write report when the post-write doctor fails', async () => {
  const s = await sandbox()
  const cfg = join(s.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc')
  const original = '{\n  // keep\n  "model": "old/model"\n}'
  await writeFile(cfg, original)
  const result = await handlers['set-model']({
    flags: { model: 'openrouter/new', scope: 'global' },
    env: s.env,
    cwd: s.home,
    runDoctorFn: async () => { throw new Error('synthetic post-write failure') },
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.stdout, /Set the default model to openrouter\/new/)
  assert.match(result.stdout, /Backed up the previous file to .*opencode\.jsonc\.bak\./)
  assert.match(result.stdout, /Comments were dropped: yes/)
  assert.match(result.stdout, /Post-write doctor check failed: synthetic post-write failure/)
  assert.equal(JSON.parse(await readFile(cfg, 'utf8')).model, 'openrouter/new')
  assert.equal(await readFile(cfg + '.bak', 'utf8'), original)
})

test('the gate is off by default, toggles, and status is exactly bare on/off', async () => {
  const s = await sandbox()
  const initial = await cli(s.env, ['gate', '--status'])
  assert.equal(initial.code, 0)
  assert.equal(initial.stdout, 'off\n')
  const firstOn = await cli(s.env, ['gate', '--on'])
  assert.equal(firstOn.code, 0)
  assert.equal((await cli(s.env, ['gate', '--status'])).stdout, 'on\n')
  const repeatedOn = await cli(s.env, ['gate', '--on'])
  assert.equal(repeatedOn.code, 0)
  assert.equal((await cli(s.env, ['gate', '--status'])).stdout, 'on\n')
  const firstOff = await cli(s.env, ['gate', '--off'])
  assert.equal(firstOff.code, 0)
  assert.equal((await cli(s.env, ['gate', '--status'])).stdout, 'off\n')
  const repeatedOff = await cli(s.env, ['gate', '--off'])
  assert.equal(repeatedOff.code, 0)
  assert.equal((await cli(s.env, ['gate', '--status'])).stdout, 'off\n')
})

test('repair clears a stale portfile and reports it', async () => {
  const s = await sandbox()
  const brokerDir = join(s.env.XDG_STATE_HOME, 'opencode-plugin-cc', 'broker')
  await mkdir(brokerDir, { recursive: true })
  await writeFile(join(brokerDir, 'port.json'), JSON.stringify({ port: 1, pid: 2 ** 22, password: 'p', startedAt: 0 }))
  const r = await cli(s.env, ['repair'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Cleared a stale broker portfile\./)
  await assert.rejects(() => readFile(join(brokerDir, 'port.json')), { code: 'ENOENT' })
})

test('repair reports an unverified broker and clears it after the process exits', async (t) => {
  const s = await sandbox()
  await withFakeOwnedBroker(t, s.env, async ({ pid, startedAt }) => {
    const endpoint = await readEndpoint(s.env)
    const mismatchedStartedAt = startedAt - 60_000
    await writeEndpoint({ ...endpoint, startedAt: mismatchedStartedAt }, s.env)
    const owner = await readJson(join(brokerDir(s.env), 'owner.json'), {})
    await writeJson(join(brokerDir(s.env), 'owner.json'), {
      ...owner,
      startedAt: mismatchedStartedAt,
    })
    await assert.rejects(
      () => ensureBroker({ env: s.env, timeoutMs: 100 }),
      /broker process identity could not be proven; records remain for repair/,
    )
    const blocked = await cli(s.env, ['repair'])
    assert.equal(blocked.code, 1)
    assert.match(blocked.stdout, /Could not prove broker process identity/)
    assert.match(blocked.stdout, /run \/opencode:repair again/)
    assert.equal(isAlive(pid), true)
    assert.equal((await readEndpoint(s.env)).pid, pid)

    await terminate(pid, { graceMs: 1000 })
    const repaired = await cli(s.env, ['repair'])
    assert.equal(repaired.code, 0)
    assert.match(repaired.stdout, /Cleared a stale broker portfile\./)
    assert.equal(await readEndpoint(s.env), null)
  })
})
