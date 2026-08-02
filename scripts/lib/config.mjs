import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { readJsonc, mergeWriteJson } from './fs.mjs'

export const CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json'

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function globalDir(env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || '', '.config')
  return join(base, 'opencode')
}

export function configCandidates({ env = process.env, cwd = process.cwd() } = {}) {
  const names = ['opencode.json', 'opencode.jsonc']
  return {
    project: names.map(name => join(cwd, name)),
    global: names.map(name => join(globalDir(env), name)),
  }
}

export async function resolveDefaultModel({ env = process.env, cwd = process.cwd() } = {}) {
  const candidates = configCandidates({ env, cwd })
  for (const source of ['project', 'global']) {
    for (const path of candidates[source]) {
      const config = await readJsonc(path).catch(() => null)
      if (config && typeof config.model === 'string' && config.model) {
        return { model: config.model, source, path }
      }
    }
  }
  return null
}

export async function configTargetPath({ scope, env = process.env, cwd = process.cwd() } = {}) {
  if (scope !== 'project' && scope !== 'global') {
    throw new Error(`scope must be project or global, got: ${scope}`)
  }
  const candidates = configCandidates({ env, cwd })[scope]
  for (const path of candidates) {
    if (await exists(path)) return path
  }
  return candidates[0]
}

export async function setModel({ model, scope, env = process.env, cwd = process.cwd() }) {
  if (!model || !String(model).includes('/')) {
    throw new Error(`model must be in provider/model form, got: ${model}`)
  }
  const path = await configTargetPath({ scope, env, cwd })
  const { backup, created } = await mergeWriteJson(
    path,
    { model },
    { schemaUrl: CONFIG_SCHEMA_URL },
  )
  return { path, backup, created }
}
