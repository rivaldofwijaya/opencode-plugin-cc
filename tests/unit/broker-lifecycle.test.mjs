import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reapOrphans,
} from '../../scripts/lib/broker-lifecycle.mjs'
import {
  writeEndpoint,
} from '../../scripts/lib/broker-endpoint.mjs'
import { isAlive, spawnDetached, terminate } from '../../scripts/lib/process.mjs'
import { brokerDir, writeJson } from '../../scripts/lib/state.mjs'

test('broker ps identity parsing is stable under caller locale and timezone', async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), 'ocbroker-identity-'))
  const psDir = join(stateHome, 'ps-bin')
  const env = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    HOME: '/nonexistent',
    LC_ALL: 'fr_FR.UTF-8',
    LANG: 'fr_FR.UTF-8',
    TZ: 'Pacific/Kiritimati',
  }
  const startedAt = Date.UTC(2026, 7, 2, 12, 34, 56)
  const password = 'test-password'
  const command = 'node serve --port 0 --hostname 127.0.0.1'
  await mkdir(psDir, { recursive: true, mode: 0o700 })
  const psPath = join(psDir, 'ps')
  await writeFile(psPath, [
    '#!/bin/sh',
    '[ "$LC_ALL" = C ] || exit 2',
    '[ "$LANG" = C ] || exit 2',
    '[ "$TZ" = UTC ] || exit 2',
    `printf '%s\\n' 'Sun Aug  2 12:34:56 2026 ${command}'`,
    '',
  ].join('\n'), { mode: 0o700 })
  await chmod(psPath, 0o700)
  env.PATH = `${psDir}:${env.PATH || ''}`

  const child = spawnDetached(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
    'serve', '--port', '0', '--hostname', '127.0.0.1',
  ])
  t.after(async () => {
    if (isAlive(child.pid)) await terminate(child.pid, { graceMs: 1000 }).catch(() => {})
  })

  await writeEndpoint({ port: 9, pid: child.pid, password, startedAt }, env)
  await writeJson(join(brokerDir(env), 'owner.json'), {
    pid: child.pid,
    port: 9,
    startedAt,
    passwordHash: createHash('sha256').update(password).digest('hex'),
  })

  assert.deepEqual(await reapOrphans(env), { cleared: true })
  assert.equal(isAlive(child.pid), false)
})
