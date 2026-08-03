#!/usr/bin/env node
import { registerSession, unregisterSession, pruneStale } from './lib/tracked-jobs.mjs'
import { addSessionRef, releaseRef, reapOrphans } from './lib/broker-lifecycle.mjs'
import { cancelAll } from './lib/job-control.mjs'
import { installHookSafety, logHookFailureBounded, readPayload, withTimeout } from './lib/hook-io.mjs'
import { refsPath } from './lib/broker-endpoint.mjs'
import { readJson } from './lib/state.mjs'

const HOOK_HARD_TIMEOUT_MS = 1_200
const LIFECYCLE_TIMEOUT_MS = 700
const PAYLOAD_TIMEOUT_MS = 100

installHookSafety(HOOK_HARD_TIMEOUT_MS)

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

function sessionHolderToken(ccSessionId) {
  return `session:${encodeURIComponent(ccSessionId)}`
}

async function releaseSessionRefIfOwned(ccSessionId) {
  const token = sessionHolderToken(ccSessionId)
  const refs = await readJson(refsPath(process.env), {})
  if (!refs?.[ccSessionId]?.[token]) return
  await releaseRef(ccSessionId, process.env, token)
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
    // The lifecycle holder has a stable, session-scoped token. Inspect it
    // before releasing so a failed SessionStart cannot tokenlessly consume a
    // migrated pid:null holder belonging to something else. If this hook did
    // not acquire that token, it releases nothing; repair handles stale refs.
    await releaseSessionRefIfOwned(ccSessionId)
  } catch (error) {
    errors.push(error)
  }

  try {
    await unregisterSession(ccSessionId)
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

    if (process.env.OPENCODE_TEST_HANG_LIFECYCLE_WORK === '1') {
      // Test-only indefinite work exercises the outer hard watchdog directly.
      await new Promise(() => {})
    }

    await withTimeout(async () => {
      if (event === 'SessionStart') {
        await registerSession(ccSessionId)
        await pruneStale()
        await reapOrphans()
        await addSessionRef(ccSessionId, process.env, sessionHolderToken(ccSessionId))
      } else if (event === 'SessionEnd') {
        await handleSessionEnd(ccSessionId)
      } else {
        throw new Error(`unknown lifecycle event: ${event}`)
      }
    }, LIFECYCLE_TIMEOUT_MS, `Session ${event ?? '(missing event)'}`)
  } catch (error) {
    await logHookFailureBounded({
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
}

try {
  await main()
} finally {
  // R18.1 exemption: best-effort lifecycle hooks always exit 0 so a plugin
  // fault can never break the user's Claude Code session, including a failure
  // while constructing the failure-log payload above.
  process.exit(0)
}
