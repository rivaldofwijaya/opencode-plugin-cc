import { join } from 'node:path'
import { readJsonc, mergeWriteJson } from './fs.mjs'

const ENV_HINTS = [
  ['ANTHROPIC_API_KEY', 'anthropic'],
  ['OPENAI_API_KEY', 'openai'],
  ['OPENROUTER_API_KEY', 'openrouter'],
  ['GEMINI_API_KEY', 'google'],
  ['GROQ_API_KEY', 'groq'],
  ['DEEPSEEK_API_KEY', 'deepseek'],
]

export function authFilePath(env = process.env) {
  const base = env.XDG_DATA_HOME || join(env.HOME || '', '.local', 'share')
  return join(base, 'opencode', 'auth.json')
}

export async function readAuth(env = process.env) {
  return (await readJsonc(authFilePath(env))) ?? {}
}

export async function listProviders(env = process.env) {
  return Object.keys(await readAuth(env)).sort()
}

export async function envProviderHints(env = process.env) {
  return ENV_HINTS.filter(([envVar]) => env[envVar])
    .map(([envVar, provider]) => ({ provider, envVar }))
}

function redact(key) {
  const value = String(key)
  return value.length >= 8 ? '****' + value.slice(-4) : '****'
}

export async function setKey({ provider, key, env = process.env }) {
  let providerText
  try {
    providerText = String(provider)
  } catch {
    throw new Error('set-key requires a non-empty --provider')
  }
  if (!provider || !providerText.trim()) throw new Error('set-key requires a non-empty --provider')

  let keyText
  try {
    keyText = String(key)
  } catch {
    throw new Error('set-key requires a non-empty --key')
  }
  if (!key || !keyText.trim()) throw new Error('set-key requires a non-empty --key')

  try {
    const path = authFilePath(env)
    const { backup, created } = await mergeWriteJson(
      path,
      { [provider]: { type: 'api', key } },
      { mode: 0o600 },
    )
    return { provider, redacted: redact(keyText), backup, created, path }
  } catch {
    throw new Error('set-key failed')
  }
}
