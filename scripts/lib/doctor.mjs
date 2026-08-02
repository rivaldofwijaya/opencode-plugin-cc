import { resolveBinary, binaryVersion, meetsFloor, MIN_VERSION } from './opencode.mjs'
import { listProviders, envProviderHints } from './credentials.mjs'
import { resolveDefaultModel } from './config.mjs'
import { ensureBroker, shutdownBroker } from './broker-lifecycle.mjs'

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
    server: { ok: false, detail: notChecked },
  }
}

function finish(report) {
  report.ok = report.gaps.length === 0
  return report
}

export async function runDoctor({ env = process.env, cwd = process.cwd(), checkServer = true } = {}) {
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
    let broker
    try {
      broker = await ensureBroker({ env })
      report.server = { ok: true, detail: `reachable at ${broker.baseUrl}` }
    } catch (error) {
      report.server = { ok: false, detail: error.message }
      report.gaps.push(`the opencode server would not start: ${error.message}`)
    } finally {
      // Doctor only probes the server; it does not own a session reference.
      if (broker) await shutdownBroker(env)
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
