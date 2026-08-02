import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, spawnDetached, terminate, isAlive } from '../../scripts/lib/process.mjs'

test('run captures stdout and a zero exit', async () => {
  const r = await run('node', ['-e', 'console.log("hi")'])
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), 'hi')
  assert.equal(r.timedOut, false)
})

test('run reports a non-zero exit without throwing', async () => {
  const r = await run('node', ['-e', 'console.error("bad"); process.exit(3)'])
  assert.equal(r.code, 3)
  assert.match(r.stderr, /bad/)
})

test('run times out and reports timedOut', async () => {
  const r = await run('node', ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 300 })
  assert.equal(r.timedOut, true)
})

test('run escalates when a child ignores SIGTERM and leaves it dead', async () => {
  const started = Date.now()
  const r = await run('node', [
    '-e',
    'process.stdout.write(String(process.pid)); process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 2000)',
  ], { timeoutMs: 100 })
  const elapsed = Date.now() - started
  const pid = Number(r.stdout)
  assert.equal(r.timedOut, true)
  assert.ok(elapsed < 1500, `timeout escalation took ${elapsed}ms`)
  assert.equal(isAlive(pid), false)
})

test('run writes input to stdin', async () => {
  const r = await run('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'ping' })
  assert.equal(r.stdout, 'ping')
})

test('terminate stops a detached child and isAlive goes false', async () => {
  const child = spawnDetached('node', ['-e', 'setInterval(()=>{}, 1000)'])
  assert.equal(isAlive(child.pid), true)
  const outcome = await terminate(child.pid, { graceMs: 2000 })
  assert.ok(['exited', 'killed'].includes(outcome))
  assert.equal(isAlive(child.pid), false)
})

test('terminate escalates when a detached child ignores SIGTERM', async () => {
  const child = spawnDetached('node', [
    '-e',
    'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setTimeout(() => process.exit(0), 5000)',
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', (data) => {
        if (String(data).includes('ready')) resolve()
        else reject(new Error(`unexpected readiness output: ${String(data)}`))
      })
      child.once('error', reject)
    })
    const outcome = await terminate(child.pid, { graceMs: 100 })
    assert.equal(outcome, 'killed')
    assert.equal(isAlive(child.pid), false)
  } finally {
    if (isAlive(child.pid)) process.kill(child.pid, 'SIGKILL')
  }
})

test('terminate reports gone for an unknown pid', async () => {
  assert.equal(await terminate(2 ** 22, { graceMs: 100 }), 'gone')
})
