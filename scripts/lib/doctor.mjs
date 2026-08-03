import { resolveBinary, binaryVersion, meetsFloor, MIN_VERSION } from './opencode.mjs'
import { listProviders, envProviderHints } from './credentials.mjs'
import { resolveDefaultModel } from './config.mjs'
import { ensureBroker, shutdownBroker } from './broker-lifecycle.mjs'
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
    server: {
      ok: false,
      detail: notChecked,
      broker: { disposition: 'not checked', shutdown: 'not attempted' },
    },
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

function brokerReport(disposition, shutdown = 'not attempted', location) {
  return { disposition, shutdown, ...(location ? { location } : {}) }
}

export async function runDoctor({
  env = process.env,
  cwd = process.cwd(),
  checkServer = true,
  ensureBrokerFn = ensureBroker,
  shutdownBrokerFn = shutdownBroker,
} = {}) {
  const report = initialReport()

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
    report.binary.error = error.message
    report.binary.detail = error.message
    report.gaps.push('the opencode binary was not found')
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
    if (!ok) report.gaps.push(`opencode ${value} is older than the required ${MIN_VERSION}`)
  } catch (error) {
    report.version.detail = error.message
    report.gaps.push(`could not read the opencode version: ${error.message}`)
    return finish(report)
  }

  report.auth.providers = await listProviders(env)
  report.auth.envHints = await envProviderHints(env)
  report.auth.ok = report.auth.providers.length > 0
  report.auth.detail = report.auth.ok
    ? `${report.auth.providers.length} provider${report.auth.providers.length === 1 ? '' : 's'} configured`
    : 'no providers configured'
  if (!report.auth.ok) report.gaps.push('no opencode provider credentials are configured')

  const model = await resolveDefaultModel({ env, cwd })
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
    report.gaps.push('no default model is configured')
  }

  if (checkServer) {
    let observed
    let broker
    let shouldShutdown = false
    try {
      observed = await inspectBroker(env)
      broker = await ensureBrokerFn({ env })
      shouldShutdown = observed.state === 'absent'
      const location = brokerLocation(broker, observed)
      if (observed.state === 'running') {
        report.server = {
          ok: true,
          detail: `reachable at ${location}; broker was already running and was left running`,
          broker: brokerReport('pre-existing', 'not attempted', location),
        }
      } else if (observed.state === 'absent') {
        report.server = {
          ok: true,
          detail: `reachable at ${location}; broker was started by doctor`,
          broker: brokerReport('started by doctor', 'pending', location),
        }
      } else {
        report.server = {
          ok: true,
          detail: `reachable at ${location}; doctor could not prove broker ownership and left it running (${observed.detail})`,
          broker: brokerReport('ownership uncertain', 'not attempted', location),
        }
        report.gaps.push(`the broker ownership could not be established; it was left running at ${location}`)
      }
    } catch (error) {
      const location = brokerLocation(broker, observed)
      report.server = {
        ok: false,
        detail: error.message,
        broker: brokerReport('probe failed; no doctor shutdown was attempted', 'not attempted', location),
      }
      report.gaps.push(`the opencode server would not start: ${error.message}`)
    } finally {
      // The existing broker API does not return whether it reused or started
      // the endpoint. A live preflight is therefore the ownership proof. If
      // inspection is uncertain, doctor deliberately leaves the broker alone.
      if (broker && shouldShutdown) {
        const location = brokerLocation(broker, observed)
        try {
          const outcome = await shutdownBrokerFn(env)
          report.server.broker.shutdown = `completed (${outcome})`
          report.server.detail += `; doctor shut down its broker (${outcome})`
        } catch (error) {
          const detail = `could not shut down the broker at ${location}: ${error.message}; it may still be running`
          report.server.ok = false
          report.server.broker.shutdown = { ok: false, detail }
          report.server.detail += `; ${detail}`
          report.gaps.push(detail)
        }
      }

      if (!broker && report.server.broker?.disposition.startsWith('probe failed')) {
        const after = await inspectBroker(env)
        if (after.state !== 'absent') {
          const location = brokerLocation(null, after)
          const detail = `the broker may still be running at ${location} after the failed probe`
          report.server.detail += `; ${detail}`
          report.server.broker = brokerReport('probe failed; broker state remains', 'not attempted', location)
          report.gaps.push(detail)
        }
      }
    }
  }

  return finish(report)
}

export function requireReady(report, { need = ['binary', 'version', 'auth', 'model'] } = {}) {
  for (const key of need) {
    if (report[key]?.ok) continue
    const gap = report.gaps[0] ?? `the ${key} check did not pass`
    throw new CompanionError(`opencode is not ready: ${gap}. Run /opencode:setup.`)
  }
}
