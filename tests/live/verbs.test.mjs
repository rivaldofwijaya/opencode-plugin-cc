import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../scripts/lib/process.mjs'
import { companion, live, model, liveEnv, repo } from './helpers.mjs'

const skip = !live && 'set OPENCODE_LIVE=1 to run'

test('live: a real adversarial review renders a review', { skip }, async () => {
  const d = await repo()
  await writeFile(join(d, 'div.js'), 'export function div(a, b) { return a / b }\nexport const half = (n) => div(n, 0)\n')
  const env = liveEnv()

  const r = await run(process.execPath, [companion, 'adversarial-review', '--wait', '--model', model], {
    cwd: d,
    env,
    timeoutMs: 300000,
  })
  // Exit 0 means the job finished AND the output parsed against the review
  // schema. It says nothing about which findings came back.
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /opencode review/)
  assert.ok(r.stdout.length > 40, 'the adversarial review produced no meaningful output')
})
