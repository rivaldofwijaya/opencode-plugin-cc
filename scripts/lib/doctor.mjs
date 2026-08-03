import { randomUUID } from 'node:crypto'
import { resolveBinary, binaryVersion, meetsFloor, MIN_VERSION } from './opencode.mjs'
import { listProviders, envProviderHints } from './credentials.mjs'
import { resolveDefaultModel } from './config.mjs'
import { ensureBroker, addRef, releaseRef } from './broker-lifecycle.mjs'
import { baseUrlFor, readEndpoint } from './broker-endpoint.mjs'
import { isAlive } from './process.mjs'
import { OpencodeClient } from './server.mjs'

export class CompanionError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'CompanionError'
    this.exitCode = exitCode
  }
}

function initialReport() {
  const notChecked = 'not checked'
  return {
    ok: false,
    gaps: [],
    binary: { ok: false, path: null, source: null, error: null, detail: notChecked },
    version: { ok: false, value: null, floor: MIN_VERSION, detail: notChecked },
    auth: { ok: false, providers: [], envHints: [], detail: notChecked },
    model: { ok: false, value: null, source: null, path: null, detail: notChecked },
    server: { ok: false, detail: notChecked, broker: brokerReport('not checked') },
  }
}

function finish(report) {
  report.ok = report.gaps.length === 0
  return report
}

async function inspectBroker(env) {
  let endpoint
  try {
    endpoint = await readEndpoint(env)
  } catch (error) {
    return { state: 'unknown', detail: `could not inspect the broker endpoint: ${error.message}` }
  }

  if (!endpoint || !Number.isInteger(endpoint.pid) || !Number.isInteger(endpoint.port)) {
    return { state: 'absent', endpoint: null }
  }

  let alive
  try {
    alive = isAlive(endpoint.pid)
  } catch (error) {
    return {
      state: 'unknown',
      endpoint,
      baseUrl: baseUrlFor(endpoint),
      detail: `could not inspect broker process ${endpoint.pid}: ${error.message}`,
    }
  }
  if (!alive) return { state: 'absent', endpoint }

  const baseUrl = baseUrlFor(endpoint)
  const client = new OpencodeClient(baseUrl, { password: endpoint.password })
  if (await client.health({ timeoutMs: 2000 })) return { state: 'running', endpoint, baseUrl }
  return {
    state: 'uncertain',
    endpoint,
    baseUrl,
    detail: `process ${endpoint.pid} owns the recorded broker endpoint but did not answer a health check`,
  }
}

function brokerLocation(broker, observed) {
  return broker?.baseUrl || observed?.baseUrl || 'the recorded broker endpoint'
}

function brokerReport(observation, location) {
  return {
    disposition: 'session refcounted',
    observation,
    refcount: 'not attempted',
    shutdown: 'not attempted',
    ...(location ? { location } : {}),
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function addGap(report, gap) {
  if (!report.gaps.includes(gap)) report.gaps.push(gap)
}

function referenceSummary(remaining) {
  const plural = remaining !== 1
  return `${remaining} other session reference${plural ? 's' : ''} ${plural ? 'remain' : 'remains'}`
}

function recordRelease(report, outcome, location) {
  report.server.broker.refcount = outcome

  if (!outcome || typeof outcome !== 'object'
    || typeof outcome.released !== 'boolean'
    || !Number.isInteger(outcome.remaining) || outcome.remaining < 0
    || typeof outcome.shutdown !== 'boolean') {
    const detail = `doctor's broker reference release returned an invalid result at ${location}; the server may still be running there`
    report.server.ok = false
    report.server.broker.shutdown = { ok: false, detail }
    report.server.detail += `; ${detail}`
    addGap(report, detail)
    return
  }

  if (outcome.released === false) {
    const detail = `doctor's broker reference was not released at ${location}; the server may still be running there`
    report.server.ok = false
    report.server.broker.shutdown = { ok: false, detail }
    report.server.detail += `; ${detail}`
    addGap(report, detail)
    return
  }

  if (outcome.shutdown) {
    report.server.broker.shutdown = 'completed (doctor released the last broker reference)'
    report.server.detail += '; doctor released its broker reference and stopped the broker'
    return
  }

  report.server.broker.shutdown = `not attempted (${referenceSummary(outcome.remaining)})`
  report.server.detail += `; doctor released its broker reference; the broker remains running because ${referenceSummary(outcome.remaining)}`
}

export async function runDoctor({
  env = process.env,
  cwd = process.cwd(),
  checkServer = true,
  ensureBrokerFn = ensureBroker,
  addRefFn = addRef,
  releaseRefFn = releaseRef,
  inspectBrokerFn = inspectBroker,
  listProvidersFn = listProviders,
  envProviderHintsFn = envProviderHints,
  resolveDefaultModelFn = resolveDefaultModel,
} = {}) {
  const report = initialReport()

  try {
    try {
      const bin = await resolveBinary({ env })
      report.binary = {
        ok: true,
        path: bin.path,
        source: bin.source,
        error: null,
        detail: `found ${bin.path} via ${bin.source}`,
      }
    } catch (error) {
      report.binary.error = errorMessage(error)
      report.binary.detail = errorMessage(error)
      addGap(report, 'the opencode binary was not found')
      return finish(report)
    }

    try {
      const value = await binaryVersion(report.binary.path, { env })
      const ok = meetsFloor(value)
      report.version = {
        ok,
        value,
        floor: MIN_VERSION,
        detail: ok ? `meets the required ${MIN_VERSION}` : `older than the required ${MIN_VERSION}`,
      }
      if (!ok) addGap(report, `opencode ${value} is older than the required ${MIN_VERSION}`)
    } catch (error) {
      report.version.detail = errorMessage(error)
      addGap(report, `could not read the opencode version: ${errorMessage(error)}`)
      return finish(report)
    }

    try {
      report.auth.providers = await listProvidersFn(env)
      report.auth.envHints = await envProviderHintsFn(env)
      report.auth.ok = report.auth.providers.length > 0
      report.auth.detail = report.auth.ok
        ? `${report.auth.providers.length} provider${report.auth.providers.length === 1 ? '' : 's'} configured`
        : 'no providers configured'
      if (!report.auth.ok) addGap(report, 'no opencode provider credentials are configured')
    } catch (error) {
      report.auth.detail = `could not inspect provider credentials: ${errorMessage(error)}`
      addGap(report, `could not inspect opencode provider credentials: ${errorMessage(error)}`)
      return finish(report)
    }

    try {
      const model = await resolveDefaultModelFn({ env, cwd })
      if (model) {
        report.model = {
          ok: true,
          value: model.model,
          source: model.source,
          path: model.path,
          detail: `configured in ${model.source} config`,
        }
      } else {
        report.model.detail = 'no default model configured'
        addGap(report, 'no default model is configured')
      }
    } catch (error) {
      report.model.detail = `could not resolve the default model: ${errorMessage(error)}`
      addGap(report, `could not resolve the default model: ${errorMessage(error)}`)
      return finish(report)
    }

    if (checkServer) {
      let observed
      let broker
      let referenceHeld = false
      let probeFailed = false
      const doctorIdentity = `doctor:${process.pid}:${randomUUID()}`

      try {
        // Doctor participates in the session refcount, which is R12.2's
        // permitted alternative to guessing whether it owns the broker.
        await addRefFn(doctorIdentity, env)
        referenceHeld = true
        observed = await inspectBrokerFn(env)
        broker = await ensureBrokerFn({ env })
        const location = brokerLocation(broker, observed)
        const observation = observed?.state ?? 'not observed'
        const observationDetail = observed?.detail ? ` (${observed.detail})` : ''
        report.server = {
          ok: true,
          detail: `reachable at ${location}; broker observation was ${observation}${observationDetail}`,
          broker: brokerReport(observation, location),
        }
      } catch (error) {
        probeFailed = referenceHeld
        const location = brokerLocation(broker, observed)
        const observation = observed?.state ?? (referenceHeld ? 'probe failed' : 'reference not acquired')
        const detail = errorMessage(error)
        report.server = {
          ok: false,
          detail,
          broker: brokerReport(observation, location),
        }
        addGap(report, `the opencode server would not start: ${detail}`)
      } finally {
        const location = brokerLocation(broker, observed)
        // If addRef failed, no reference was taken, so there is nothing to release.
        if (referenceHeld) {
          try {
            const outcome = await releaseRefFn(doctorIdentity, env)
            recordRelease(report, outcome, location)
          } catch (error) {
            const detail = `could not release doctor's broker reference at ${location}: ${errorMessage(error)}; the server may still be running there`
            report.server.ok = false
            report.server.broker.refcount = { ok: false, detail }
            report.server.broker.shutdown = { ok: false, detail }
            report.server.detail += `; ${detail}`
            addGap(report, detail)
          }
        }

        if (probeFailed && !broker) {
          try {
            const after = await inspectBrokerFn(env)
            if (after.state !== 'absent') {
              const afterLocation = brokerLocation(null, after)
              const detail = `the broker may still be running at ${afterLocation} after the failed probe`
              report.server.detail += `; ${detail}`
              report.server.broker.observation = after.state
              report.server.broker.location = afterLocation
              addGap(report, detail)
            }
          } catch (error) {
            const detail = `could not re-inspect the broker at ${location} after the failed probe: ${errorMessage(error)}; it may still be running there`
            report.server.ok = false
            report.server.detail += `; ${detail}`
            report.server.broker.shutdown = { ok: false, detail }
            addGap(report, detail)
          }
        }
      }
    }

    return finish(report)
  } catch (error) {
    // Every doctor path is a report, including an unexpected pre-server
    // helper exception. The CLI can then render the gap instead of crashing.
    const detail = `doctor could not complete all checks: ${errorMessage(error)}`
    addGap(report, detail)
    return finish(report)
  }
}

export function requireReady(report, { need = ['binary', 'version', 'auth', 'model'] } = {}) {
  for (const key of need) {
    if (report[key]?.ok) continue
    const gap = report.gaps[0] ?? `the ${key} check did not pass`
    throw new CompanionError(`opencode is not ready: ${gap}. Run /opencode:setup.`)
  }
}
