import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAlive, run, spawnDetached, terminate } from '../../scripts/lib/process.mjs'
import { brokerDir, writeJson } from '../../scripts/lib/state.mjs'
import { shutdownBroker } from '../../scripts/lib/broker-lifecycle.mjs'
import { writeEndpoint } from '../../scripts/lib/broker-endpoint.mjs'
import { cancelJob } from '../../scripts/lib/job-control.mjs'
import { listJobs } from '../../scripts/lib/tracked-jobs.mjs'

export function trackChild(t, child) {
  t.after(async () => {
    if (child?.pid && isAlive(child.pid)) {
      await terminate(child.pid, { graceMs: 1000 }).catch(() => {})
    }
  })
  return child
}

export function spawnTracked(t, command, args, options) {
  return trackChild(t, spawnDetached(command, args, options))
}

export function trackJobs(t, env, ccSessionId) {
  t.after(async () => {
    const jobs = await listJobs(ccSessionId, env).catch(() => [])
    for (const job of jobs) {
      if (job.state === 'running') await cancelJob(job.id, env).catch(() => {})
    }
    await shutdownBroker(env).catch(() => {})
  })
}

const fakeBrokerCommand = `${process.execPath} -e setInterval(() => {}, 1000) serve --port 0 --hostname 127.0.0.1`

async function realPsAvailable(env) {
  try {
    const result = await run('ps', ['-p', String(process.pid), '-o', 'pid='], {
      env: { ...env },
      timeoutMs: 1000,
    })
    return result.code === 0 && !result.timedOut && Boolean(result.stdout.trim())
  } catch {
    return false
  }
}

async function installPidAwarePs(env, pid, startedAt) {
  if (await realPsAvailable(env)) {
    delete env.FAKE_PS_PID
    delete env.FAKE_PS_PPID
    delete env.FAKE_PS_COMMAND
    delete env.FAKE_PS_START
    return
  }

  const psDir = join(env.XDG_STATE_HOME, 'test-bin')
  const psPath = join(psDir, 'ps')
  await mkdir(psDir, { recursive: true, mode: 0o700 })
  const psScript = [
    '#!/bin/sh',
    'pid=',
    'formats=',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -p) pid="$2"; shift 2 ;;',
    '    -o) formats="$formats $2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '[ "$pid" = "$FAKE_PS_PID" ] || exit 1',
    'case "$formats" in',
    '  " lstart= command=") printf \'%s %s\\n\' "$FAKE_PS_START" "$FAKE_PS_COMMAND" ;;',
    '  command=) printf \'%s\\n\' "$FAKE_PS_COMMAND" ;;',
    '  lstart=) printf \'%s\\n\' "$FAKE_PS_START" ;;',
    '  pid=,ppid=,command=) printf \'%s %s %s\\n\' "$FAKE_PS_PID" "$FAKE_PS_PPID" "$FAKE_PS_COMMAND" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n')
  await writeFile(psPath, psScript, { mode: 0o700 })
  await chmod(psPath, 0o700)
  env.PATH = `${psDir}:${env.PATH || ''}`
  env.FAKE_PS_PID = String(pid)
  env.FAKE_PS_PPID = '1'
  env.FAKE_PS_COMMAND = fakeBrokerCommand
  env.FAKE_PS_START = String(startedAt)
}

// The child is registered before any state setup can fail, so malformed test
// state or an assertion during setup cannot leak this fixture process.
export async function withFakeOwnedBroker(t, env, callback) {
  const child = trackChild(t, spawnDetached(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
    'serve', '--port', '0', '--hostname', '127.0.0.1',
  ]))
  const password = 'test-password'
  const startedAt = Date.now()
  try {
    await installPidAwarePs(env, child.pid, startedAt)
    await writeEndpoint({ port: 1, pid: child.pid, password, startedAt }, env)
    await writeJson(join(brokerDir(env), 'owner.json'), {
      pid: child.pid,
      port: 1,
      startedAt,
      passwordHash: createHash('sha256').update(password).digest('hex'),
    })
    return await callback({ pid: child.pid, startedAt })
  } finally {
    await shutdownBroker(env).catch(() => {})
    if (isAlive(child.pid)) await terminate(child.pid, { graceMs: 1000 }).catch(() => {})
  }
}
