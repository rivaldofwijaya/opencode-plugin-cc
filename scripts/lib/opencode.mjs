import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const MIN_VERSION = '1.18.0'

const cache = new Map()
export function clearBinaryCache() { cache.clear() }

async function isExecutable(p) {
  try { await access(p, constants.X_OK); return true } catch { return false }
}

function candidates(env) {
  const home = env.HOME || ''
  const out = []
  if (env.OPENCODE_BIN) out.push({ path: env.OPENCODE_BIN, source: 'env' })
  for (const dir of (env.PATH || '').split(':').filter(Boolean)) {
    out.push({ path: join(dir, 'opencode'), source: 'path' })
  }
  if (home) {
    out.push({ path: join(home, '.opencode', 'bin', 'opencode'), source: 'home' })
    out.push({ path: join(home, '.local', 'bin', 'opencode'), source: 'local-bin' })
  }
  out.push({ path: '/opt/homebrew/bin/opencode', source: 'homebrew' })
  out.push({ path: '/usr/local/bin/opencode', source: 'usr-local' })
  if (home) out.push({ path: join(home, '.bun', 'bin', 'opencode'), source: 'bun' })
  return out
}

export async function resolveBinary({ env = process.env } = {}) {
  const key = `${env.OPENCODE_BIN || ''}|${env.PATH || ''}|${env.HOME || ''}`
  if (cache.has(key)) return cache.get(key)
  for (const c of candidates(env)) {
    if (await isExecutable(c.path)) { cache.set(key, c); return c }
  }
  throw new Error('opencode binary not found')
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

export const meetsFloor = (version) => compareVersions(version, MIN_VERSION) >= 0

export async function binaryVersion(binPath) {
  const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 20000 })
  const m = stdout.match(/(\d+\.\d+\.\d+)/)
  if (!m) throw new Error(`could not parse opencode version from: ${stdout.trim()}`)
  return m[1]
}

export function buildServeArgs({ port = 0, hostname = '127.0.0.1' } = {}) {
  return ['serve', '--port', String(port), '--hostname', hostname]
}

export function buildRunArgs(opts = {}) {
  const args = ['run']
  if (opts.dir) args.push('--dir', opts.dir)
  if (opts.auto !== false) args.push('--auto')
  if (opts.pure) args.push('--pure')
  if (opts.model) args.push('-m', opts.model)
  const variant = opts.variant ?? opts.effort
  if (variant) args.push('--variant', variant)
  if (opts.agent) args.push('--agent', opts.agent)
  if (opts.session) args.push('--session', opts.session)
  else if (opts.continue) args.push('--continue')
  if (opts.fork) args.push('--fork')
  if (opts.format) args.push('--format', opts.format)
  if (opts.title) args.push('--title', opts.title)
  return args
}
