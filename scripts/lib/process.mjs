import { spawn } from 'node:child_process'

const TIMEOUT_KILL_GRACE_MS = 250
const POLL_MS = 25

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function timeoutValue(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

export function run(cmd, args, { cwd, env, timeoutMs = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, TIMEOUT_KILL_GRACE_MS)
    }, timeoutValue(timeoutMs, 120000))

    child.stdout.on('data', (data) => { stdout += data.toString() })
    child.stderr.on('data', (data) => { stderr += data.toString() })
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ code, stdout, stderr, timedOut })
    })

    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export function spawnDetached(cmd, args, { cwd, env, stdio = 'ignore' } = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: env ?? process.env,
    detached: true,
    stdio,
  })
  child.unref()
  return child
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

async function waitUntilGone(pid, deadline) {
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await wait(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
  }
  return true
}

export async function terminate(pid, { graceMs = 3000 } = {}) {
  if (!isAlive(pid)) return 'gone'

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error.code === 'ESRCH') return 'gone'
    throw error
  }

  const grace = timeoutValue(graceMs, 3000)
  if (await waitUntilGone(pid, Date.now() + grace)) return 'exited'

  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error.code === 'ESRCH') return 'exited'
    throw error
  }

  await waitUntilGone(pid, Date.now() + Math.max(1000, grace))
  return 'killed'
}
