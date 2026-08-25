import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../../src/lib/process.mjs'
import { companion, live, model, liveEnv, repo } from './helpers.mjs'

test('live: a real review returns findings or a clean report', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\nexport const half = (n) => div(n, 0)\n')
  const env = liveEnv()
  const r = await run(process.execPath, [companion, 'review', '--wait', '--model', model], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /opencode review/)
  assert.ok(r.stdout.length > 40, 'the review produced no meaningful output')
})

test('live: a real task returns model output', { skip: !live && 'set OPENCODE_LIVE=1 to run' }, async () => {
  const d = await repo()
  const env = liveEnv()
  const r = await run(process.execPath, [companion, 'task', '--wait', '--model', model, '--', 'Reply with the single word: ready'], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout.toLowerCase(), /ready/)
})
