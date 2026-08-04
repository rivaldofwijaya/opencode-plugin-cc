import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIN_VERSION, compareVersions, meetsFloor, resolveBinary, clearBinaryCache,
  buildRunArgs, buildServeArgs
} from '../../scripts/lib/opencode.mjs'

async function fakeBin(dir, name = 'opencode') {
  const p = join(dir, name)
  await writeFile(p, '#!/bin/sh\necho 1.18.11\n')
  await chmod(p, 0o755)
  return p
}

test('compareVersions orders correctly', () => {
  assert.equal(compareVersions('1.18.11', '1.18.2'), 1)
  assert.equal(compareVersions('1.18.0', '1.18.0'), 0)
  assert.equal(compareVersions('1.9.0', '1.18.0'), -1)
})

test('meetsFloor uses MIN_VERSION', () => {
  assert.equal(MIN_VERSION, '1.18.0')
  assert.equal(meetsFloor('1.18.11'), true)
  assert.equal(meetsFloor('1.17.9'), false)
})

test('OPENCODE_BIN wins over everything', async () => {
  clearBinaryCache()
  const d = await mkdtemp(join(tmpdir(), 'ocbin-'))
  const p = await fakeBin(d)
  const r = await resolveBinary({ env: { OPENCODE_BIN: p, PATH: '', HOME: '/nonexistent' } })
  assert.deepEqual(r, { path: p, source: 'env' })
})

test('OPENCODE_BIN takes precedence over PATH and ~/.opencode/bin', async () => {
  clearBinaryCache()
  const envDir = await mkdtemp(join(tmpdir(), 'ocenv-'))
  const pathDir = await mkdtemp(join(tmpdir(), 'ocpath-'))
  const home = await mkdtemp(join(tmpdir(), 'ochome-'))
  await mkdir(join(home, '.opencode', 'bin'), { recursive: true })
  const envBinary = await fakeBin(envDir, 'opencode-env')
  const pathBinary = await fakeBin(pathDir)
  const homeBinary = await fakeBin(join(home, '.opencode', 'bin'))
  const r = await resolveBinary({ env: { OPENCODE_BIN: envBinary, PATH: pathDir, HOME: home } })
  assert.deepEqual(r, { path: envBinary, source: 'env' })
  assert.notEqual(envBinary, pathBinary)
  assert.notEqual(envBinary, homeBinary)
})

test('PATH is used when OPENCODE_BIN is unset', async () => {
  clearBinaryCache()
  const d = await mkdtemp(join(tmpdir(), 'ocbin-'))
  const p = await fakeBin(d)
  const r = await resolveBinary({ env: { PATH: d, HOME: '/nonexistent' } })
  assert.deepEqual(r, { path: p, source: 'path' })
})

test('PATH takes precedence over ~/.opencode/bin when OPENCODE_BIN is unset', async () => {
  clearBinaryCache()
  const pathDir = await mkdtemp(join(tmpdir(), 'ocpath-'))
  const home = await mkdtemp(join(tmpdir(), 'ochome-'))
  await mkdir(join(home, '.opencode', 'bin'), { recursive: true })
  const pathBinary = await fakeBin(pathDir)
  const homeBinary = await fakeBin(join(home, '.opencode', 'bin'))
  const r = await resolveBinary({ env: { PATH: pathDir, HOME: home } })
  assert.deepEqual(r, { path: pathBinary, source: 'path' })
  assert.notEqual(pathBinary, homeBinary)
})

test('~/.opencode/bin is used when PATH misses', async () => {
  clearBinaryCache()
  const home = await mkdtemp(join(tmpdir(), 'ochome-'))
  await mkdir(join(home, '.opencode', 'bin'), { recursive: true })
  const p = await fakeBin(join(home, '.opencode', 'bin'))
  const r = await resolveBinary({ env: { PATH: '/nonexistent', HOME: home } })
  assert.deepEqual(r, { path: p, source: 'home' })
})

test('~/.opencode/bin takes precedence over ~/.local/bin when PATH is empty', async () => {
  clearBinaryCache()
  const home = await mkdtemp(join(tmpdir(), 'ochome-'))
  const opencodeDir = join(home, '.opencode', 'bin')
  const localDir = join(home, '.local', 'bin')
  await mkdir(opencodeDir, { recursive: true })
  await mkdir(localDir, { recursive: true })
  const homeBinary = await fakeBin(opencodeDir)
  const localBinary = await fakeBin(localDir)
  const r = await resolveBinary({ env: { PATH: '', HOME: home } })
  assert.deepEqual(r, { path: homeBinary, source: 'home' })
  assert.notEqual(homeBinary, localBinary)
})

test('PATH uses the earliest entry with an executable', async () => {
  clearBinaryCache()
  const earlyDir = await mkdtemp(join(tmpdir(), 'ocpath-early-'))
  const lateDir = await mkdtemp(join(tmpdir(), 'ocpath-late-'))
  const earlyBinary = await fakeBin(earlyDir)
  const lateBinary = await fakeBin(lateDir)
  const r = await resolveBinary({ env: { PATH: `${earlyDir}:${lateDir}`, HOME: '/nonexistent' } })
  assert.deepEqual(r, { path: earlyBinary, source: 'path' })
  assert.notEqual(earlyBinary, lateBinary)
})

test('missing binary throws a named error', async () => {
  clearBinaryCache()
  await assert.rejects(
    () => resolveBinary({ env: { PATH: '/nonexistent', HOME: '/nonexistent' } }),
    /opencode binary not found/
  )
})

test('buildServeArgs defaults to an ephemeral loopback port', () => {
  assert.deepEqual(buildServeArgs(), ['serve', '--port', '0', '--hostname', '127.0.0.1'])
})

test('buildRunArgs emits --auto and --dir by default and nothing optional', () => {
  assert.deepEqual(buildRunArgs({ dir: '/repo' }), ['run', '--dir', '/repo', '--auto'])
})

test('buildRunArgs maps model, variant, agent, session, fork, pure', () => {
  const a = buildRunArgs({
    dir: '/repo', model: 'openrouter/x', variant: 'high', agent: 'general',
    session: 'ses_1', fork: true, pure: true
  })
  assert.deepEqual(a, [
    'run', '--dir', '/repo', '--auto', '--pure',
    '-m', 'openrouter/x', '--variant', 'high', '--agent', 'general',
    '--session', 'ses_1', '--fork'
  ])
})

test('buildRunArgs accepts --effort as an alias for --variant, variant wins', () => {
  assert.deepEqual(buildRunArgs({ dir: '/r', effort: 'high' }), ['run', '--dir', '/r', '--auto', '--variant', 'high'])
  assert.deepEqual(buildRunArgs({ dir: '/r', effort: 'low', variant: 'max' }), ['run', '--dir', '/r', '--auto', '--variant', 'max'])
})

test('buildRunArgs can disable auto', () => {
  assert.deepEqual(buildRunArgs({ dir: '/r', auto: false }), ['run', '--dir', '/r'])
})
