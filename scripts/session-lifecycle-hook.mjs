#!/usr/bin/env node
import { registerSession, unregisterSession, pruneStale } from './lib/tracked-jobs.mjs'
import { addRef, releaseRef, reapOrphans } from './lib/broker-lifecycle.mjs'
import { cancelAll } from './lib/job-control.mjs'
import { logHookFailure, readPayload, withTimeout } from './lib/hook-io.mjs'

const LIFECYCLE_TIMEOUT_MS = 15_000
const PAYLOAD_TIMEOUT_MS = 1_000

function payloadSessionId(payload) {
  if (typeof payload?.session_id === 'string' && payload.session_id.trim()) {
    return payload.session_id
  }
  if (typeof process.env.CLAUDE_SESSION_ID === 'string' && process.env.CLAUDE_SESSION_ID.trim()) {
    return process.env.CLAUDE_SESSION_ID
  }
  return 'default'
}

function combinedError(errors) {
  return new Error(errors.map(error => error.message).join('; '))
}

async function handleSessionEnd(ccSessionId) {
  const errors = []

  try {
    // SessionEnd records cancellation but does not terminate live detached
    // work; its PID holder remains protected until that worker releases it.
    await cancelAll(ccSessionId, process.env, { preserveLive: true })
  } catch (error) {
    errors.push(error)
  }

  try {
    await unregisterSession(ccSessionId)
  } catch (error) {
    errors.push(error)
  }

  try {
    // Do not reap here: a detached background worker may still be live after
    // SessionEnd. releaseRef's PID check preserves such a live holder.
    await releaseRef(ccSessionId)
  } catch (error) {
    errors.push(error)
  }

  if (errors.length) throw combinedError(errors)
}

async function main() {
  const event = process.argv[2]
  let payload = {}

  try {
    payload = await readPayload({ timeoutMs: PAYLOAD_TIMEOUT_MS })
    const ccSessionId = payloadSessionId(payload)

    await withTimeout(async () => {
      if (event === 'SessionStart') {
        await registerSession(ccSessionId)
        await pruneStale()
        await reapOrphans()
        await addRef(ccSessionId)
      } else if (event === 'SessionEnd') {
        await handleSessionEnd(ccSessionId)
      } else {
        throw new Error(`unknown lifecycle event: ${event}`)
      }
    }, LIFECYCLE_TIMEOUT_MS, `Session ${event ?? '(missing event)'}`)
  } catch (error) {
    await logHookFailure({
      hook: 'session-lifecycle',
      event: event ?? null,
      error,
    })
    try {
      process.stderr.write(`opencode-plugin-cc ${event ?? 'lifecycle'} hook: ${error.message}\n`)
    } catch {
      // A broken stderr pipe cannot change the best-effort hook contract.
    }
  }

  // R18.1 exemption: best-effort lifecycle hooks always exit 0 so a plugin
  // fault can never break the user's Claude Code session.
  process.exit(0)
}

await main()
