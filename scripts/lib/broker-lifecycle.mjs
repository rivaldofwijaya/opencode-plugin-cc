import { createHash, randomBytes } from 'node:crypto'
import { chmod, readdir, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawnDetached, terminate, isAlive } from './process.mjs'
import { OpencodeClient } from './server.mjs'
import { readJson, writeJson, sessionsDir } from './state.mjs'
import {
  readEndpoint,
  writeEndpoint,
  clearEndpoint,
  baseUrlFor,
  acquireLock,
  releaseLock,
  refsPath,
} from './broker-endpoint.mjs'
import { brokerDir } from './state.mjs'

// The client always sends OPENCODE_SERVER_PASSWORD. Verification against a
// real binary is intentionally not performed here: this task must never spawn
// a developer's real opencode process. Loopback binding remains the boundary
// for versions where the password is advisory.

const brokerScript = fileURLToPath(new URL('../server-broker.mjs', import.meta.url))
const ownerPath = (env) => join(brokerDir(env), 'owner.json')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const LOCK_WAIT_MS = 20_000

function clientFor(rec) {
  return new OpencodeClient(baseUrlFor(rec), { password: rec.password })
}

function passwordHash(password) {
  return createHash('sha256').update(String(password || '')).digest('hex')
}

function ownerRecordFor(rec) {
  return {
    pid: rec.pid,
    port: rec.port,
    startedAt: rec.startedAt,
    passwordHash: passwordHash(rec.password),
  }
}

async function writeOwner(rec, env) {
  await writeJson(ownerPath(env), ownerRecordFor(rec))
  await chmod(ownerPath(env), 0o600)
}

async function ownsEndpointProcess(rec, env) {
  if (!rec?.pid || !rec?.password) return false
  const owner = await readJson(ownerPath(env), null)
  return owner?.pid === rec.pid
    && owner.port === rec.port
    && owner.startedAt === rec.startedAt
    && owner.passwordHash === passwordHash(rec.password)
}

async function clearOwner(rec, env) {
  const owner = await readJson(ownerPath(env), null)
  if (!rec || (owner && await ownsEndpointProcess(rec, env))) {
    try {
      await unlink(ownerPath(env))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

async function liveEndpoint(env) {
  const rec = await readEndpoint(env)
  if (!rec || !Number.isInteger(rec.pid) || !Number.isInteger(rec.port)) return null
  if (!isAlive(rec.pid)) return null
  return (await clientFor(rec).health({ timeoutMs: 2000 })) ? rec : null
}

async function cleanupOrphanLocked(env) {
  const rec = await readEndpoint(env)
  if (!rec) return false
  if (await liveEndpoint(env)) return false

  // A hand-written or foreign portfile is never allowed to turn reaping into
  // a kill of an unrelated process. Only a process with our private owner
  // record may be signalled; dead PIDs need no signal at all.
  if (rec.pid && isAlive(rec.pid) && await ownsEndpointProcess(rec, env)) {
    await terminate(rec.pid, { graceMs: 3000 })
  }
  await clearEndpoint(env)
  await clearOwner(rec, env)
  return true
}

export async function reapOrphans(env = process.env) {
  // Acquiring the lock before inspecting and clearing is the spawn-once
  // guarantee: a live startup lock is never unlinked by stale cleanup.
  if (!await acquireLock(env)) return { cleared: false }
  try {
    return { cleared: await cleanupOrphanLocked(env) }
  } finally {
    await releaseLock(env)
  }
}

function redact(text, secret) {
  return secret ? String(text).split(String(secret)).join('[REDACTED]') : String(text)
}

async function spawnBroker(env, timeoutMs) {
  const password = randomBytes(24).toString('hex')
  const child = spawnDetached(process.execPath, [brokerScript], {
    env: { ...env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let reported
    let settled = false
    let timer

    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
      child.removeAllListeners('error')
      child.removeAllListeners('close')
      child.removeAllListeners('exit')
    }

    const fail = async (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (isAlive(child.pid)) await terminate(child.pid, { graceMs: 3000 })
      reject(error)
    }

    const finish = async (code, signal) => {
      if (settled) return
      if (!reported) {
        await fail(new Error(
          `opencode server would not start.\n${redact(stderr.trim() || stdout.trim(), password)}`,
        ))
        return
      }
      settled = true
      cleanup()
      if (code !== 0) {
        if (isAlive(reported.pid)) await terminate(reported.pid, { graceMs: 3000 })
        reject(new Error(
          `opencode broker exited with ${code ?? `signal ${signal}`}.\n${redact(stderr.trim(), password)}`,
        ))
        return
      }
      resolve({ ...reported, password })
    }

    timer = setTimeout(() => {
      void fail(new Error('timed out waiting for opencode serve to report a port'))
    }, Math.max(1, timeoutMs))

    child.stdout.on('data', (data) => {
      stdout += data.toString()
      for (const line of stdout.split('\n')) {
        try {
          const value = JSON.parse(line)
          if (Number.isInteger(value.port) && Number.isInteger(value.pid)) {
            reported = { port: value.port, pid: value.pid }
            break
          }
        } catch {
          // The broker may receive non-JSON diagnostic output; keep scanning.
        }
      }
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
      if (stderr.length > 8192) stderr = stderr.slice(-8192)
    })
    child.once('error', (error) => { void fail(new Error(`opencode broker process error: ${error.message}`)) })
    child.once('close', (code, signal) => { void finish(code, signal) })
    child.once('exit', (code, signal) => {
      if (code !== 0 && !reported) void finish(code, signal)
    })
  })
}

async function ensureBrokerLocked(env, timeoutMs) {
  const existing = await liveEndpoint(env)
  if (existing) {
    return {
      baseUrl: baseUrlFor(existing),
      password: existing.password,
      pid: existing.pid,
      client: clientFor(existing),
    }
  }

  await cleanupOrphanLocked(env)
  let rec
  try {
    rec = await spawnBroker(env, Math.max(1, Math.min(25_000, timeoutMs)))
    rec.startedAt = Date.now()
    await writeOwner(rec, env)
    await writeEndpoint(rec, env)

    const client = clientFor(rec)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const healthTimeout = Math.max(1, Math.min(1500, deadline - Date.now()))
      if (await client.health({ timeoutMs: healthTimeout })) {
        return { baseUrl: baseUrlFor(rec), password: rec.password, pid: rec.pid, client }
      }
      await sleep(200)
    }
    throw new Error(`opencode server started on port ${rec.port} but never answered GET /doc`)
  } catch (error) {
    // This order is deliberate: the detached server must be terminated before
    // its endpoint/ownership state is removed, or startup failures leak a
    // server that later callers cannot safely identify.
    if (rec?.pid && isAlive(rec.pid)) await terminate(rec.pid, { graceMs: 3000 })
    await clearEndpoint(env)
    await clearOwner(rec, env)
    throw error
  }
}

async function withLock(env, callback, { timeoutMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await acquireLock(env)) {
      try {
        return await callback()
      } finally {
        await releaseLock(env)
      }
    }
    await sleep(10)
  }
  throw new Error('timed out waiting for the opencode broker lock')
}

export async function ensureBroker({ env = process.env, timeoutMs = 20_000 } = {}) {
  const existing = await liveEndpoint(env)
  if (existing) {
    return {
      baseUrl: baseUrlFor(existing),
      password: existing.password,
      pid: existing.pid,
      client: clientFor(existing),
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await acquireLock(env)) {
      try {
        return await ensureBrokerLocked(env, timeoutMs)
      } finally {
        await releaseLock(env)
      }
    }

    const concurrent = await liveEndpoint(env)
    if (concurrent) {
      return {
        baseUrl: baseUrlFor(concurrent),
        password: concurrent.password,
        pid: concurrent.pid,
        client: clientFor(concurrent),
      }
    }
    await sleep(200)
  }
  throw new Error('timed out waiting for another process to start the opencode server')
}

async function writeRefs(refs, env) {
  await writeJson(refsPath(env), refs)
  await chmod(refsPath(env), 0o600)
}

const localHolderTokens = new Map()

function localHolderKey(env, ccSessionId) {
  return `${refsPath(env)}\u0000${ccSessionId}`
}

function rememberLocalHolder(env, ccSessionId, holderToken) {
  const key = localHolderKey(env, ccSessionId)
  const tokens = localHolderTokens.get(key) ?? []
  tokens.push(holderToken)
  localHolderTokens.set(key, tokens)
}

function forgetLocalHolder(env, ccSessionId, holderToken) {
  const key = localHolderKey(env, ccSessionId)
  const tokens = localHolderTokens.get(key)
  if (!tokens) return
  const remaining = tokens.filter((token) => token !== holderToken)
  if (remaining.length) localHolderTokens.set(key, remaining)
  else localHolderTokens.delete(key)
}

function legacyHolderToken(ccSessionId, at) {
  return `legacy:${encodeURIComponent(ccSessionId)}:${at}`
}

function normalizeRefs(raw) {
  const refs = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refs

  for (const [ccSessionId, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      refs[ccSessionId] = {
        [legacyHolderToken(ccSessionId, value)]: { pid: null, at: value },
      }
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue

    const holders = {}
    for (const [holderToken, holder] of Object.entries(value)) {
      if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue
      if (!Number.isFinite(holder.at)) continue
      holders[holderToken] = {
        pid: Number.isInteger(holder.pid) ? holder.pid : null,
        at: holder.at,
      }
    }
    if (Object.keys(holders).length) refs[ccSessionId] = holders
  }
  return refs
}

function pruneDeadHolders(refs) {
  for (const [ccSessionId, holders] of Object.entries(refs)) {
    for (const [holderToken, holder] of Object.entries(holders)) {
      if (Number.isInteger(holder.pid) && !isAlive(holder.pid)) delete holders[holderToken]
    }
    if (!Object.keys(holders).length) delete refs[ccSessionId]
  }
  return refs
}

function pruneUnknownSessions(refs, known) {
  for (const [ccSessionId, holders] of Object.entries(refs)) {
    if (known.has(ccSessionId)) continue

    // A live process can own a non-session holder (for example doctor's
    // probe reference), so registry absence alone is not stale evidence.
    // pruneDeadHolders already removed holders whose recorded PID is dead;
    // pid-less legacy holders remain reclaimable here. Filter per holder so a
    // live non-session holder cannot shelter a dead or legacy sibling.
    for (const [holderToken, holder] of Object.entries(holders)) {
      if (!Number.isInteger(holder.pid) || !isAlive(holder.pid)) delete holders[holderToken]
    }
    if (!Object.keys(holders).length) delete refs[ccSessionId]
  }
  return refs
}

function holderCount(refs) {
  return Object.values(refs).reduce((count, holders) => count + Object.keys(holders).length, 0)
}

function chooseLegacyReleaseToken(ccSessionId, env, holders) {
  // The two-argument form is compatibility-only. It may release a holder
  // only when local ownership, this process's PID, or the synthetic legacy
  // pid:null marker proves that it is safe to do so.
  const key = localHolderKey(env, ccSessionId)
  const local = localHolderTokens.get(key) ?? []
  for (let index = local.length - 1; index >= 0; index -= 1) {
    const token = local[index]
    if (holders[token]) return token
  }

  const owned = Object.entries(holders)
    .filter(([, holder]) => holder.pid === process.pid)
    .sort(([, a], [, b]) => a.at - b.at)
  if (owned[0]?.[0]) return owned[0][0]

  return Object.entries(holders)
    .filter(([, holder]) => holder.pid === null)
    .sort(([, a], [, b]) => a.at - b.at)[0]?.[0]
}

function addKnownValue(set, value) {
  if (typeof value === 'string' && value) set.add(value)
}

function addKnownData(set, data) {
  if (Array.isArray(data)) {
    for (const value of data) addKnownValue(set, value)
    return
  }
  if (!data || typeof data !== 'object') return
  for (const key of ['id', 'sessionID', 'ccSessionId', 'ccSessionID']) addKnownValue(set, data[key])
  for (const key of ['ids', 'sessionIDs', 'sessionIds', 'sessions', 'knownSessions']) {
    if (Array.isArray(data[key])) for (const value of data[key]) addKnownValue(set, typeof value === 'string' ? value : value?.id)
  }
}

async function knownSessions(env) {
  const known = new Set()
  let entries
  try {
    entries = await readdir(sessionsDir(env), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return known
    throw error
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const isRegistry = ['registry.json', 'known.json', 'sessions.json'].includes(entry.name)
    const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : entry.name
    if (!isRegistry && id) addKnownValue(known, id)
    if (!entry.isFile()) continue
    const data = await readJson(join(sessionsDir(env), entry.name), null)
    if (isRegistry) addKnownData(known, data)
    else if (data) addKnownData(known, data)
  }
  return known
}

// Counts returned by addRef/releaseRef are live holder records, not sessions.
// A single Claude Code session can therefore contribute several references.
export async function addRef(ccSessionId, env = process.env, holderToken) {
  return await withLock(env, async () => {
    const next = pruneDeadHolders(normalizeRefs(await readJson(refsPath(env), {})))
    const token = typeof holderToken === 'string' && holderToken
      ? holderToken
      : randomBytes(24).toString('hex')
    const holders = next[ccSessionId] ?? {}
    if (holders[token]) throw new Error(`broker holder token is already in use: ${token}`)
    holders[token] = { pid: process.pid, at: Date.now() }
    next[ccSessionId] = holders
    await writeRefs(next, env)
    rememberLocalHolder(env, ccSessionId, token)
    return holderCount(next)
  })
}

async function shutdownBrokerLocked(env) {
  const rec = await readEndpoint(env)
  if (!rec) {
    await clearEndpoint(env)
    await clearOwner(null, env)
    return 'gone'
  }

  let outcome = 'gone'
  if (rec.pid && isAlive(rec.pid) && await ownsEndpointProcess(rec, env)) {
    const terminated = await terminate(rec.pid, { graceMs: 3000 })
    outcome = terminated === 'gone' ? 'gone' : 'stopped'
  }
  await clearEndpoint(env)
  await clearOwner(rec, env)
  return outcome
}

export async function releaseRef(ccSessionId, env = process.env, holderToken) {
  return await withLock(env, async () => {
    const next = pruneDeadHolders(normalizeRefs(await readJson(refsPath(env), {})))
    const tokenless = !(typeof holderToken === 'string' && holderToken)
    let released = false
    const holders = next[ccSessionId]
    if (holders) {
      const token = tokenless
        ? chooseLegacyReleaseToken(ccSessionId, env, holders)
        : holderToken
      if (token && holders[token]) {
        delete holders[token]
        forgetLocalHolder(env, ccSessionId, token)
        released = true
      }
      if (!Object.keys(holders).length) delete next[ccSessionId]
    }

    const known = await knownSessions(env)
    pruneUnknownSessions(next, known)
    await writeRefs(next, env)

    const remaining = holderCount(next)
    const shutdown = remaining === 0
    if (shutdown) await shutdownBrokerLocked(env)
    if (!released) return { remaining, shutdown, released: false }
    return tokenless
      ? { remaining, shutdown, released: true }
      : { remaining, shutdown }
  })
}

export async function shutdownBroker(env = process.env) {
  return await withLock(env, () => shutdownBrokerLocked(env))
}
