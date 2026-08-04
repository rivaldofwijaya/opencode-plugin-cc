import { readFile, appendFile, mkdir, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { atomicWrite } from './fs.mjs'

export function stateRoot(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || '', '.local', 'state')
  return join(base, 'opencode-plugin-cc')
}

export const jobsDir = (env = process.env) => join(stateRoot(env), 'jobs')
export const brokerDir = (env = process.env) => join(stateRoot(env), 'broker')
export const sessionsDir = (env = process.env) => join(stateRoot(env), 'sessions')
export const transfersDir = (env = process.env) => join(stateRoot(env), 'transfers')
export const jobDir = (jobId, env = process.env) => join(jobsDir(env), jobId)

export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  // This helper is used for plugin state paths. Tighten state directories
  // created by older versions without changing user-owned paths in fs.mjs.
  await chmod(path, 0o700)
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback
    throw error
  }
}

export async function writeJson(path, value) {
  await ensureDir(dirname(path))
  await atomicWrite(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

export async function appendJsonl(path, obj) {
  await ensureDir(dirname(path))
  await appendFile(path, JSON.stringify(obj) + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function readJsonl(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn write or external garbage must not lose the surrounding events.
    }
  }
  return out
}
