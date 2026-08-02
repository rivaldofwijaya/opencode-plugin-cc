import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { atomicWrite } from './fs.mjs'

export function stateRoot(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || '', '.local', 'state')
  return join(base, 'opencode-plugin-cc')
}

export const jobsDir = (env = process.env) => join(stateRoot(env), 'jobs')
export const brokerDir = (env = process.env) => join(stateRoot(env), 'broker')
export const sessionsDir = (env = process.env) => join(stateRoot(env), 'sessions')
export const jobDir = (jobId, env = process.env) => join(jobsDir(env), jobId)

export async function ensureDir(path) {
  await mkdir(path, { recursive: true })
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
  await atomicWrite(path, JSON.stringify(value, null, 2) + '\n')
}

export async function appendJsonl(path, obj) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(obj) + '\n')
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
