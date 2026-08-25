import { readFile, writeFile, rename, stat, chmod, copyFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

let counter = 0

export async function atomicWrite(path, contents, { mode = 0o644 } = {}) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${counter++}`
  let tempCreated = false

  try {
    await writeFile(tmp, contents, { mode, flag: 'wx' })
    tempCreated = true
    await chmod(tmp, mode)
    await rename(tmp, path)
    tempCreated = false
  } catch (error) {
    if (tempCreated || error.code !== 'EEXIST') {
      await unlink(tmp).catch(() => {})
    }
    throw error
  }
}

export async function backupFile(path) {
  let mode
  try {
    mode = (await stat(path)).mode & 0o777
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }

  const bak = `${path}.bak`
  await copyFile(path, bak)
  await chmod(bak, mode)
  return bak
}

export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      if (i < text.length) out += '\n'
      continue
    }

    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      if (i < text.length) i++
      continue
    }

    out += ch
  }

  return out
}

export async function readJsonc(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }

  return JSON.parse(stripJsonComments(text))
}

export async function mergeWriteJson(path, patch, { mode = 0o644, schemaUrl } = {}) {
  const existing = await readJsonc(path)
  const created = existing === null
  const backup = created ? null : await backupFile(path)
  const merged = created && schemaUrl !== undefined
    ? { $schema: schemaUrl, ...patch }
    : { ...(existing ?? {}), ...patch }

  await atomicWrite(path, JSON.stringify(merged, null, 2) + '\n', { mode })
  return { backup, created }
}
