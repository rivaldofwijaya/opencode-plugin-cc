import { readFile, appendFile, mkdir, chmod, readdir } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { atomicWrite } from './fs.mjs'

const PLUGIN_STATE_DIR = 'opencode-plugin-cc'

export function stateRoot(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || '', '.local', 'state')
  return join(base, 'opencode-plugin-cc')
}

export const jobsDir = (env = process.env) => join(stateRoot(env), 'jobs')
export const brokerDir = (env = process.env) => join(stateRoot(env), 'broker')
export const sessionsDir = (env = process.env) => join(stateRoot(env), 'sessions')
export const transfersDir = (env = process.env) => join(stateRoot(env), 'transfers')
export const jobDir = (jobId, env = process.env) => join(jobsDir(env), jobId)

function pluginStateRoot(path) {
  let current = resolve(path)
  while (true) {
    if (basename(current) === PLUGIN_STATE_DIR) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function tightenStateTree(root) {
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    await chmod(directory, 0o700)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
    }
  }
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const root = pluginStateRoot(path)
  if (root) {
    // State trees may predate the private-mode change. Tighten every directory
    // below our own root, never an ancestor or a user-owned sibling.
    await tightenStateTree(root)
  } else {
    await chmod(path, 0o700)
  }
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
