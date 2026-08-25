import { randomBytes } from 'node:crypto'
import { chmod, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { brokerDir, ensureDir, readJson, writeJson } from './state.mjs'
import { isAlive } from './process.mjs'

const STALE_LOCK_MS = 60_000

export const endpointPath = (env = process.env) => join(brokerDir(env), 'port.json')
export const lockPath = (env = process.env) => join(brokerDir(env), 'lock')
export const refsPath = (env = process.env) => join(brokerDir(env), 'refs.json')

export const baseUrlFor = (rec) => `http://127.0.0.1:${rec.port}`

async function ensurePrivateBrokerDir(env) {
  const dir = brokerDir(env)
  await ensureDir(dir)
  return dir
}

async function unlinkIfMissing(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function readEndpoint(env = process.env) {
  return await readJson(endpointPath(env), null)
}

export async function writeEndpoint(rec, env = process.env) {
  await ensurePrivateBrokerDir(env)
  await writeJson(endpointPath(env), rec)
  await chmod(endpointPath(env), 0o600)
}

// Endpoint cleanup removes only the endpoint record. The caller that acquired
// the lock owns its release and must call releaseLock exactly once; the only
// other code allowed to remove a lock is the stale-lock reclaim path above.
export async function clearEndpoint(env = process.env) {
  await unlinkIfMissing(endpointPath(env))
}

async function readLock(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return { text, record: JSON.parse(text) }
  } catch (error) {
    if (error instanceof SyntaxError) return { text, record: null }
    throw error
  }
}

async function lockIsStale(path) {
  const lock = await readLock(path)
  if (!lock) return true
  const record = lock.record
  const validRecord = record
    && typeof record === 'object'
    && !Array.isArray(record)
    && Number.isInteger(record.pid)
    && record.pid > 0
    && Number.isFinite(record.at)
  if (!validRecord) {
    // A contender can observe the tiny interval between O_EXCL creation and
    // the owner's JSON write. Treat a fresh malformed/empty lock as live;
    // only an old one is eligible for stale recovery.
    try {
      return Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS
    } catch (error) {
      if (error.code === 'ENOENT') return true
      throw error
    }
  }
  if (!isAlive(record.pid)) return true
  return Date.now() - record.at > STALE_LOCK_MS
}

async function removeStaleLock(path) {
  const observed = await readLock(path)
  if (!observed || !await lockIsStale(path)) return false

  const quarantine = `${path}.stale-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    // rename moves exactly the directory entry we observed, so a contender can
    // claim a fresh lock without this cleanup unlinking the contender's file.
    await rename(path, quarantine)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }

  try {
    const moved = await readFile(quarantine, 'utf8')
    if (moved !== observed.text) {
      // A replaced lock must never be deleted by stale cleanup. Restore only if
      // the path is still empty; otherwise leave the new owner's lock alone.
      try {
        await rename(quarantine, path)
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
        await unlinkIfMissing(quarantine)
      }
      return false
    }
  } catch (error) {
    await unlinkIfMissing(quarantine)
    throw error
  }

  await unlinkIfMissing(quarantine)
  return true
}

export async function acquireLockAt(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      } catch (error) {
        await unlinkIfMissing(path)
        throw error
      } finally {
        await handle.close()
      }
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (attempt === 0 && await removeStaleLock(path)) continue
      return false
    }
  }
  return false
}

export async function releaseLockAt(path) {
  await unlinkIfMissing(path)
}

export async function acquireLock(env = process.env) {
  await ensurePrivateBrokerDir(env)
  return acquireLockAt(lockPath(env))
}

export async function releaseLock(env = process.env) {
  return releaseLockAt(lockPath(env))
}
