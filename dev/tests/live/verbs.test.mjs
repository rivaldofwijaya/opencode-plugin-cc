import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../../src/lib/process.mjs'
import { lastOpencodeSession } from '../../../src/lib/tracked-jobs.mjs'
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

const TRANSCRIPT_MARKER = 'Investigate the divide-by-zero in div.js'

test('live: transfer exports a handoff and seeds a real opencode session', { skip }, async () => {
  const d = await repo()
  const transcript = join(d, 'transcript.jsonl')
  await writeFile(transcript, [
    JSON.stringify({ type: 'user', message: { content: TRANSCRIPT_MARKER } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'half(n) calls div(n, 0), which returns Infinity.' }] } }),
    '',
  ].join('\n'))

  const env = liveEnv({ CLAUDE_TRANSCRIPT_PATH: transcript })

  // A real task first, so the Claude Code session already owns an opencode session.
  const task = await run(
    process.execPath,
    [companion, 'task', '--wait', '--model', model, '--', 'Reply with the single word: ready'],
    { cwd: d, env, timeoutMs: 300000 },
  )
  assert.equal(task.code, 0, `${task.stdout}\n${task.stderr}`)
  const taskSession = await lastOpencodeSession(env.CLAUDE_SESSION_ID, env)
  assert.ok(taskSession, 'the task recorded no opencode session for this Claude Code session')

  const out = join(d, 'handoff.md')
  const r = await run(process.execPath, [companion, 'transfer', '--out', out], { cwd: d, env, timeoutMs: 300000 })
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)

  const handoff = await readFile(out, 'utf8')
  assert.match(handoff, /# Handoff from Claude Code/)
  assert.ok(handoff.includes(env.CLAUDE_SESSION_ID), `handoff omitted session id ${env.CLAUDE_SESSION_ID}`)
  assert.ok(handoff.includes(TRANSCRIPT_MARKER), `handoff omitted transcript marker ${TRANSCRIPT_MARKER}`)

  assert.ok(
    r.stdout.split('\n').includes(`Handoff written to ${out}`),
    `transfer did not report the handoff path ${out}:\n${r.stdout}`,
  )

  const seeded = r.stdout.match(/Seeded opencode session: (\S+)/)
  assert.ok(seeded, `transfer reported no seeded session:\n${r.stdout}`)
  assert.ok(r.stdout.includes(`opencode --session ${seeded[1]}`), `transfer reported no resume command for ${seeded[1]}`)
  assert.notEqual(
    seeded[1],
    taskSession,
    `transfer reused task session ${taskSession} instead of creating fresh session ${seeded[1]}`,
  )

  // The seeded id is a real server-issued session, now owned by this CC session.
  assert.equal(await lastOpencodeSession(env.CLAUDE_SESSION_ID, env), seeded[1])
})
