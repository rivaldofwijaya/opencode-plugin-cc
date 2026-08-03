import { spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { stateRoot } from './state.mjs'

const DEFAULT_PAYLOAD_TIMEOUT_MS = 1_000
const MAX_PAYLOAD_BYTES = 1_024 * 1_024
export const HOOK_FAILURE_LOG_TIMEOUT_MS = 150

export function installHookSafety(timeoutMs) {
  const forceExit = () => process.exit(0)
  process.once('unhandledRejection', forceExit)
  process.once('uncaughtException', forceExit)
  setTimeout(forceExit, Math.max(0, timeoutMs))
}

function objectPayload(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
}

function parsePayload(raw) {
  if (!raw.trim()) return {}
  try {
    return objectPayload(JSON.parse(raw))
  } catch {
    return {}
  }
}

// Hook stdin is supplied by Claude Code, but a missing or open pipe must not
// keep the user's session waiting forever.
export function readPayload({ timeoutMs = DEFAULT_PAYLOAD_TIMEOUT_MS } = {}) {
  const input = process.stdin
  return new Promise((resolve) => {
    let raw = ''
    let settled = false
    let timer

    const cleanup = () => {
      clearTimeout(timer)
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('close', onClose)
      input.off('error', onError)
      input.pause()
    }

    const finish = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const onData = (chunk) => {
      raw += chunk.toString()
      if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) finish({})
    }
    const onEnd = () => finish(parsePayload(raw))
    const onClose = () => finish(parsePayload(raw))
    const onError = () => finish({})

    input.setEncoding('utf8')
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('close', onClose)
    input.once('error', onError)
    timer = setTimeout(() => finish({}), Math.max(0, timeoutMs))
    input.resume()
  })
}

export function withTimeout(task, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, Math.max(0, timeoutMs))

    Promise.resolve()
      .then(task)
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }, (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export async function logHookFailure({ hook, event, error, env = process.env }) {
  const path = join(stateRoot(env), 'hook-errors.jsonl')
  const record = {
    at: new Date().toISOString(),
    hook,
    event,
    message: errorMessage(error),
  }

  try {
    await mkdir(stateRoot(env), { recursive: true })
    await appendFile(path, JSON.stringify(record) + '\n')
  } catch (loggingError) {
    try {
      process.stderr.write(
        `opencode-plugin-cc ${hook} hook logging failure: ${errorMessage(loggingError)}\n`,
      )
    } catch {
      // The hook still has to return the approved best-effort exit code.
    }
  }
}

export async function logHookFailureBounded(args, timeoutMs = HOOK_FAILURE_LOG_TIMEOUT_MS) {
  if ((args.env ?? process.env).OPENCODE_TEST_THROW_HOOK_FAILURE_LOGGING === '1') {
    // Keep the rejection in the logger itself and leave its await pending so
    // the entrypoint's process-level rejection guard, rather than the work
    // timeout, is what proves the structural exit guarantee.
    void Promise.reject(new Error('injected failure-logging rejection'))
    return await new Promise(() => {})
  }
  const payload = JSON.stringify({
    hook: args.hook,
    event: args.event,
    error: errorMessage(args.error),
    env: args.env ?? process.env,
  })
  const childScript = [
    `import { logHookFailure } from ${JSON.stringify(import.meta.url)}`,
    'await logHookFailure(JSON.parse(process.env.OPENCODE_HOOK_LOG_ARGS))',
  ].join('\n')

  await new Promise((resolve) => {
    let settled = false
    let timer
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }

    let child
    try {
      child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        env: {
          ...process.env,
          ...(args.env ?? {}),
          OPENCODE_HOOK_LOG_ARGS: payload,
        },
        stdio: 'ignore',
      })
      child.once('error', finish)
      child.once('close', finish)
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // The child may have exited between the timer and the signal.
        }
        finish()
      }, Math.max(0, timeoutMs))
    } catch {
      finish()
    }
  })
}
