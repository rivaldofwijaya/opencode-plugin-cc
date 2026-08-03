#!/usr/bin/env node
import { readGate } from './lib/gate.mjs'
import { runDoctor } from './lib/doctor.mjs'
import { prepareReview, REVIEW_AGENT, REVIEW_TOOLS } from './lib/review-job.mjs'
import { cancelJob, runForeground } from './lib/job-control.mjs'
import { listJobs, readResult } from './lib/tracked-jobs.mjs'
import { releaseRef } from './lib/broker-lifecycle.mjs'
import { parseReviewOutput } from './lib/review-schema.mjs'
import { logHookFailureBounded, readPayload, withTimeout } from './lib/hook-io.mjs'

const BLOCKING = new Set(['critical', 'high'])
const DEFAULT_GATE_TIMEOUT_MS = 105_000
const GATE_TIMEOUT_MS = (() => {
  const configured = Number(process.env.OPENCODE_STOP_GATE_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, DEFAULT_GATE_TIMEOUT_MS)
    : DEFAULT_GATE_TIMEOUT_MS
})()
const GATE_CLEANUP_TIMEOUT_MS = 5_000
const PAYLOAD_TIMEOUT_MS = 200

let gateRun

function payloadSessionId(payload) {
  if (typeof payload?.session_id === 'string' && payload.session_id.trim()) {
    return payload.session_id
  }
  if (typeof process.env.CLAUDE_SESSION_ID === 'string' && process.env.CLAUDE_SESSION_ID.trim()) {
    return process.env.CLAUDE_SESSION_ID
  }
  return 'default'
}

function payloadCwd(payload) {
  return typeof payload?.cwd === 'string' && payload.cwd.trim()
    ? payload.cwd
    : process.cwd()
}

function isEmptyReview(error) {
  return /There is nothing to review:/.test(String(error?.message ?? error))
}

function renderBlockingFindings(findings) {
  const lines = ['opencode found blocking issues in the working tree:', '']
  for (const finding of findings) {
    lines.push(
      `[${finding.severity.toUpperCase()}] ${finding.file}`
        + (finding.line ? `:${finding.line}` : '')
        + (finding.title ? ` — ${finding.title}` : ''),
    )
    for (const line of finding.body.split('\n')) lines.push(`    ${line}`)
    lines.push('')
  }
  lines.push('Address these or explain why they are acceptable before finishing.')
  return lines.join('\n')
}

async function evaluateGate() {
  if (!(await readGate())) return null

  const payload = await readPayload({ timeoutMs: PAYLOAD_TIMEOUT_MS })
  const ccSessionId = payloadSessionId(payload)
  gateRun = {
    ccSessionId,
    initialJobIds: new Set((await listJobs(ccSessionId)).map(job => job.id)),
  }
  const cwd = payloadCwd(payload)
  const report = await runDoctor({ cwd, checkServer: false })
  if (!report.ok) return null

  let prepared
  try {
    prepared = await prepareReview({
      cwd,
      scope: 'working-tree',
      promptName: 'stop-review-gate',
    })
  } catch (error) {
    // An empty tree is a normal no-op for a Stop hook; other failures are
    // logged by the outer best-effort handler.
    if (isEmptyReview(error)) return null
    throw error
  }

  const settled = await runForeground({
    ccSessionId,
    verb: 'gate',
    prompt: prepared.prompt,
    cwd: prepared.root,
    agent: REVIEW_AGENT,
    tools: REVIEW_TOOLS,
  })
  if (settled?.state !== 'done') return null

  const parsed = parseReviewOutput((await readResult(settled.id)) ?? '')
  if (!parsed.ok) return null

  const blocking = parsed.findings.filter(finding => BLOCKING.has(finding.severity))
  if (!blocking.length) return null
  return { decision: 'block', reason: renderBlockingFindings(blocking) }
}

async function cleanupTimedOutGate() {
  if (!gateRun) return
  const jobs = await listJobs(gateRun.ccSessionId)
  const startedByThisHook = jobs.filter(job => (
    job.state === 'running'
      && job.verb === 'gate'
      && !gateRun.initialJobIds.has(job.id)
  ))

  await Promise.all(startedByThisHook.map(job => (
    cancelJob(job.id).catch(() => {})
  )))
  // startJob's foreground holder is local to this hook process. This is
  // idempotent with the execution's eventual release and prevents a timed-out
  // hook from leaving its broker reference behind.
  await releaseRef(gateRun.ccSessionId).catch(() => {})
}

async function cleanupTimedOutGateWithinBudget() {
  try {
    await withTimeout(
      () => cleanupTimedOutGate(),
      GATE_CLEANUP_TIMEOUT_MS,
      'Stop review cleanup',
    )
  } catch {
    // The durable job PID and broker holder records remain for repair/pruning.
  }
}

async function main() {
  try {
    const decision = await withTimeout(
      () => evaluateGate(),
      GATE_TIMEOUT_MS,
      'Stop review gate',
    )
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n')
  } catch (error) {
    // R18.1: log best-effort hook failures and let the user's turn finish.
    await cleanupTimedOutGateWithinBudget()
    await logHookFailureBounded({ hook: 'stop-review-gate', event: 'Stop', error })
  }

  // R18.1 exemption: the best-effort Stop hook always exits 0 so a plugin
  // fault can never block the user's Claude Code session.
  process.exit(0)
}

await main()
