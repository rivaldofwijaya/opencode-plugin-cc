import { SEVERITIES } from './review-schema.mjs'

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatJobStart(job) {
  const started = Number.isFinite(job?.startedAt) && job.startedAt > 0
    ? `started ${new Date(job.startedAt).toISOString()}`
    : null
  return started
}

function formatJobEnd(job) {
  const ended = Number.isFinite(job?.endedAt) && job.endedAt > 0
    ? `ended ${new Date(job.endedAt).toISOString()}`
    : null
  return ended
}

function formatJobTime(job) {
  return [formatJobStart(job), formatJobEnd(job)].filter(Boolean).join('; ')
}

export function formatJobTarget(job) {
  const target = [`cwd=${job?.cwd || '(unknown)'}`]
  if (job?.verb === 'review' || job?.verb === 'adversarial-review') {
    target.push(`scope=${job?.meta?.scope ?? 'unknown'}`)
    target.push(`base=${job?.meta?.base ?? 'none'}`)
  }
  return target.join('; ')
}

function stateNotice(job) {
  if (job?.state === 'failed') return 'This job failed; the captured output may be incomplete.'
  if (job?.state === 'cancelled') return 'This job was cancelled; the captured output is only a partial result.'
  if (job?.state === 'timed-out') return 'This job timed out; the captured output is only a partial result.'
  if (job?.state === 'stale') return 'This job is stale because its execution owner is no longer alive.'
  return null
}

function truncationNotice(job, formatted) {
  if (formatted || !job?.meta?.truncated) return null
  return 'Note: the input diff was truncated before this job ran; any review result may be incomplete.'
}

function incompleteFinding(finding, index) {
  if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
    return `finding ${index + 1} is not an object`
  }
  const missing = []
  for (const key of ['file', 'severity', 'confidence', 'body']) {
    if (typeof finding[key] !== 'string' || finding[key] === '') missing.push(key)
  }
  return missing.length ? `finding ${index + 1} is missing or invalid: ${missing.join(', ')}` : null
}

export function renderReview(parsed, { scope, base, truncated, jobId }) {
  const lines = []
  const scopeLabel = scope === 'branch' ? `branch diff vs ${base}` : 'working tree'
  lines.push(`opencode review — ${scopeLabel} (${jobId})`)
  if (truncated) lines.push('Note: the diff was truncated before it was sent; findings may be incomplete.')
  lines.push('')

  if (!parsed?.ok) {
    if (parsed.empty) {
      lines.push('The model returned no output, so nothing was reviewed.')
      lines.push('This is usually a transient model failure. Run the review again, or try another model.')
      return lines.join('\n')
    }
    lines.push(`The model's output could not be parsed as review JSON (${parsed?.error ?? 'unknown parse error'}).`)
    lines.push('Raw output follows verbatim:')
    lines.push('')
    lines.push(parsed?.raw ?? '(empty)')
    return lines.join('\n')
  }

  if (parsed.summary) {
    lines.push(parsed.summary)
    lines.push('')
  }

  if (!Array.isArray(parsed.findings)) {
    lines.push('Review findings are missing or invalid; no findings were rendered.')
    return lines.join('\n')
  }
  if (parsed.findings.length === 0) {
    lines.push('No findings.')
    return lines.join('\n')
  }

  const sorted = [...parsed.findings].sort(
    (a, b) => SEVERITIES.indexOf(a?.severity) - SEVERITIES.indexOf(b?.severity))
  for (const [index, finding] of sorted.entries()) {
    const incomplete = incompleteFinding(finding, index)
    if (incomplete) {
      lines.push(`[INCOMPLETE] ${incomplete}; it was not rendered as a finding.`)
      lines.push('')
      continue
    }

    const where = finding.line !== undefined && finding.line !== null
      ? `${finding.file}:${finding.line}`
      : finding.file
    const title = finding.title ? ` — ${finding.title}` : ''
    lines.push(`[${finding.severity.toUpperCase()}] (${finding.confidence} confidence) ${where}${title}`)
    for (const line of finding.body.split('\n')) lines.push(`    ${line}`)
    lines.push('')
  }
  lines.push(`${sorted.length} finding${sorted.length === 1 ? '' : 's'}.`)
  return lines.join('\n')
}

export function renderJobList(jobs, now = Date.now()) {
  if (!jobs.length) return 'No opencode jobs for this Claude Code session.'
  const lines = ['opencode jobs for this session:', '']
  for (const job of jobs) {
    const elapsed = formatElapsed((job.endedAt ?? now) - job.startedAt)
    const counters = job.counters ?? {}
    const counterText = [
      counters.steps ? `${counters.steps} steps` : null,
      counters.tools ? `${counters.tools} tools` : null,
      (counters.inputTokens || counters.outputTokens)
        ? `${counters.inputTokens ?? 0}in/${counters.outputTokens ?? 0}out tokens`
        : null,
    ].filter(Boolean).join(', ')
    const when = formatJobTime(job)
    const target = formatJobTarget(job)
    lines.push(`  ${job.id}  ${job.verb.padEnd(16)} ${job.state.padEnd(9)} ${elapsed.padStart(7)}${counterText ? `  ${counterText}` : ''}${when ? `  (${when})` : ''}  [${target}]`)
    if (job.error) lines.push(`      error: ${job.error}`)
  }
  return lines.join('\n')
}

export function renderJobResult(job, resultText, { formatted = false } = {}) {
  const when = formatJobTime(job)
  const head = `opencode ${job.verb} ${job.id} — ${job.state}${when ? ` (${when})` : ''}`
  const context = [
    head,
    `Target: ${formatJobTarget(job)}`,
    truncationNotice(job, formatted),
    stateNotice(job),
    job.error ? `Error: ${job.error}` : null,
  ].filter(Boolean)
  if (job.state === 'running') {
    const body = resultText && resultText.trim()
      ? resultText
      : '(no output yet — the job has not produced text)'
    return [...context, 'This job is still running; the output below is a partial tail.', '', body].join('\n')
  }
  if (!resultText || !resultText.trim()) return [...context, '', '(no output was produced)'].join('\n')
  return [...context, '', resultText].join('\n')
}

export function renderDoctor(report) {
  const mark = ok => (ok ? 'ok  ' : 'GAP ')
  const lines = ['opencode doctor', '']
  lines.push(`${mark(report.binary.ok)} binary      ${report.binary.path ?? 'not found'}${report.binary.source ? ` (via ${report.binary.source})` : ''}`)
  lines.push(`${mark(report.version.ok)} version     ${report.version.value ?? 'unknown'} (floor ${report.version.floor})`)
  lines.push(`${mark(report.auth.ok)} auth        ${report.auth.providers.length ? report.auth.providers.join(', ') : 'no providers configured'}`)
  lines.push(`${mark(report.model.ok)} model       ${report.model.value ?? 'no default model'}${report.model.source ? ` (${report.model.source}: ${report.model.path})` : ''}`)
  lines.push(`${mark(report.server.ok)} server      ${report.server.detail}`)
  lines.push('')
  if (report.ok) {
    lines.push('All checks passed.')
  } else {
    lines.push('Gaps:')
    for (const gap of report.gaps) lines.push(`  - ${gap}`)
    lines.push('')
    lines.push('Run /opencode:setup to fix these.')
  }
  return lines.join('\n')
}
