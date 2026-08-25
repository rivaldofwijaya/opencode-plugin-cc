import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { VERBS } from '../../src/opencode-companion.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))

export function extractCompanionVerbs(text) {
  const pattern = /opencode-companion\.mjs["']?\s+([a-z][a-z-]*)\b/g
  return [...String(text).matchAll(pattern)].map(match => match[1])
}

function assertKnownCompanionVerbs(path, verbs) {
  for (const verb of verbs) {
    assert.ok(
      VERBS.includes(verb),
      `${path} invokes companion verb "${verb}" which the companion does not implement (implemented: ${VERBS.join(', ')})`,
    )
  }
}

async function markdownFiles() {
  const out = []
  for (const dir of ['commands', 'agents']) {
    for (const f of await readdir(root + dir)) {
      if (f.endsWith('.md')) out.push({ path: `${dir}/${f}`, text: await readFile(root + dir + '/' + f, 'utf8') })
    }
  }
  return out
}

test('all eight commands ship', async () => {
  const files = (await readdir(root + 'commands')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
  assert.deepEqual(files, ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'])
})

test('every companion verb named in a command or agent actually exists', async () => {
  for (const { path, text } of await markdownFiles()) {
    assertKnownCompanionVerbs(path, extractCompanionVerbs(text))
  }
})

test('quoted companion verb extraction catches drift', () => {
  const driftedCommand = 'Run node "${CLAUDE_PLUGIN_ROOT}/src/opencode-companion.mjs" review-with-typo'
  const verbs = extractCompanionVerbs(driftedCommand)
  assert.deepEqual(verbs, ['review-with-typo'])
  assert.throws(
    () => assertKnownCompanionVerbs('fixture/drifted-command.md', verbs),
    /review-with-typo.*does not implement/,
  )
})

test('companion verb extraction also covers the existing unquoted agent form', () => {
  assert.deepEqual(extractCompanionVerbs('opencode-companion.mjs task --wait'), ['task'])
})

test('every command tells Claude to return companion stdout verbatim', async () => {
  for (const { path, text } of await markdownFiles()) {
    if (!path.startsWith('commands/')) continue
    assert.match(text, /verbatim/i, `${path} must state that companion output is returned verbatim`)
  }
})

test('each command has YAML frontmatter with a description', async () => {
  for (const { path, text } of await markdownFiles()) {
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)
    assert.ok(frontmatter, `${path} needs YAML frontmatter`)
    assert.match(frontmatter[1], /^description:/m, `${path} needs frontmatter with a description`)
  }
})

test('the rescue command routes through the opencode-rescue subagent', async () => {
  const text = await readFile(root + 'commands/rescue.md', 'utf8')
  assert.match(text, /opencode-rescue/)
})
