import { join } from 'node:path'
import { access, readFile } from 'node:fs/promises'
import { readJsonc, mergeWriteJson, stripJsonComments } from './fs.mjs'

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

export function validateModel(model) {
  let value
  try {
    value = String(model ?? '')
  } catch {
    const error = new Error('invalid model value; expected provider/model form')
    error.code = 'INVALID_MODEL'
    throw error
  }

  let problem
  if (value.length === 0) problem = 'it is empty'
  else if (!value.trim()) problem = 'it contains only whitespace'
  else if (!value.includes('/')) problem = 'it is missing the provider/model slash'
  else if (value.startsWith('/')) problem = 'it has a leading slash'
  else if (value.endsWith('/')) problem = 'it has a trailing slash'
  else if (value.includes('//')) problem = 'it has consecutive slashes'
  else if (/\s/.test(value)) problem = 'it contains whitespace'

  if (problem) {
    const error = new Error(`invalid model ${JSON.stringify(value)}: ${problem}; expected provider/model form`)
    error.code = 'INVALID_MODEL'
    throw error
  }
  return value
}

async function containsComments(path) {
  try {
    const raw = await readFile(path, 'utf8')
    return raw !== stripJsonComments(raw)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function setModel({ model, scope, env = process.env, cwd = process.cwd() }) {
  const modelText = validateModel(model)
  const path = await configTargetPath({ scope, env, cwd })
  const commentsDropped = await containsComments(path)
  const { backup, created } = await mergeWriteJson(
    path,
    { model: modelText },
    { schemaUrl: CONFIG_SCHEMA_URL },
  )
  return { path, backup, created, commentsDropped }
}
