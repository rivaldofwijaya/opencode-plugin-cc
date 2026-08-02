import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const promptsDir = fileURLToPath(new URL('../../prompts/', import.meta.url))
const promptNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export async function listPrompts(directory = promptsDir) {
  return (await readdir(directory))
    .filter(file => file.endsWith('.md'))
    .map(file => file.slice(0, -3))
    .sort()
}

export async function loadPrompt(name, vars = {}, { directory = promptsDir } = {}) {
  if (typeof name !== 'string' || !promptNamePattern.test(name)) {
    throw new Error(`unknown prompt template: ${name}`)
  }

  const path = join(directory, `${name}.md`)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`unknown prompt template: ${name}`)
    throw error
  }
  if (!text.trim()) throw new Error(`prompt file is empty: ${path}`)

  const values = vars !== null && typeof vars === 'object' ? vars : {}
  const substitutions = { ...values }
  if (name === 'adversarial-review') {
    const focus = substitutions.FOCUS
    if (focus === undefined || focus === null || String(focus).trim() === '') {
      substitutions.FOCUS = '(none given)'
    }
  }

  const filled = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) =>
    Object.hasOwn(substitutions, key) ? String(substitutions[key]) : match)
  const leftover = filled.match(/\{\{[^{}]*\}\}/)
  if (leftover) throw new Error(`unknown placeholder in prompt ${name}: ${leftover[0]}`)
  return filled
}
