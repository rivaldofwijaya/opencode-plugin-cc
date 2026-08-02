import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, chmod, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, backupFile, readJsonc, mergeWriteJson, stripJsonComments } from '../../scripts/lib/fs.mjs'

const tmp = () => mkdtemp(join(tmpdir(), 'ocfs-'))

test('atomicWrite writes contents and leaves no temp files behind', async () => {
  const d = await tmp()
  const f = join(d, 'a.json')
  await atomicWrite(f, '{"a":1}')
  assert.equal(await readFile(f, 'utf8'), '{"a":1}')
  assert.deepEqual(await readdir(d), ['a.json'])
})

test('atomicWrite honours mode 0600', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await atomicWrite(f, '{}', { mode: 0o600 })
  assert.equal((await stat(f)).mode & 0o777, 0o600)
})

test('atomicWrite overwrites an existing file without truncating on failure', {
  skip: process.getuid?.() === 0
    ? 'root bypasses directory permission bits so failure cannot be injected this way'
    : false,
}, async () => {
  const d = await tmp()
  const f = join(d, 'a.json')
  await writeFile(f, 'old')
  await chmod(d, 0o500)
  try {
    await assert.rejects(
      atomicWrite(f, 'new'),
      (error) => {
        assert.ok(['EACCES', 'EPERM'].includes(error.code), `unexpected failure code: ${error.code}`)
        return true
      },
    )
  } finally {
    await chmod(d, 0o700)
  }
  assert.equal(await readFile(f, 'utf8'), 'old')
  assert.deepEqual(await readdir(d), ['a.json'])
})

test('atomicWrite overwrites an existing file', async () => {
  const d = await tmp()
  const f = join(d, 'a.json')
  await writeFile(f, 'old')
  await atomicWrite(f, 'new')
  assert.equal(await readFile(f, 'utf8'), 'new')
})

test('backupFile copies and preserves mode; returns null when absent', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await writeFile(f, '{"a":1}')
  await chmod(f, 0o600)
  const b = await backupFile(f)
  assert.equal(b, f + '.bak')
  assert.equal(await readFile(b, 'utf8'), '{"a":1}')
  assert.equal((await stat(b)).mode & 0o777, 0o600)
  assert.equal(await backupFile(join(d, 'nope.json')), null)
})

test('backupFile rethrows non-ENOENT stat errors', async () => {
  const d = await tmp()
  const blocker = join(d, 'not-a-directory')
  await writeFile(blocker, 'blocker')
  await assert.rejects(
    backupFile(join(blocker, 'auth.json')),
    (error) => {
      assert.equal(error.code, 'ENOTDIR')
      return true
    },
  )
})

test('stripJsonComments removes line and block comments', () => {
  assert.equal(stripJsonComments('{"a":1} // trailing'), '{"a":1} ')
  assert.equal(stripJsonComments('{/* hi */"a":1}'), '{"a":1}')
})

test('stripJsonComments does not strip // inside a string', () => {
  const src = '{"$schema":"https://opencode.ai/config.json"}'
  assert.equal(stripJsonComments(src), src)
})

test('readJsonc parses a commented config and returns null when absent', async () => {
  const d = await tmp()
  const f = join(d, 'opencode.jsonc')
  await writeFile(f, '{\n  // the model\n  "model": "openrouter/x"\n}')
  assert.deepEqual(await readJsonc(f), { model: 'openrouter/x' })
  assert.equal(await readJsonc(join(d, 'nope.jsonc')), null)
})

test('readJsonc throws on malformed JSON', async () => {
  const d = await tmp()
  const f = join(d, 'malformed.jsonc')
  await writeFile(f, '{"a":')
  await assert.rejects(readJsonc(f), SyntaxError)
})

test('mergeWriteJson preserves sibling keys', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await writeFile(f, JSON.stringify({ openrouter: { type: 'api', key: 'KEEP' } }))
  await mergeWriteJson(f, { anthropic: { type: 'api', key: 'NEW' } }, { mode: 0o600 })
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.deepEqual(out.openrouter, { type: 'api', key: 'KEEP' })
  assert.deepEqual(out.anthropic, { type: 'api', key: 'NEW' })
  assert.equal((await stat(f)).mode & 0o777, 0o600)
})

test('mergeWriteJson backs up before writing', async () => {
  const d = await tmp()
  const f = join(d, 'auth.json')
  await writeFile(f, JSON.stringify({ a: 1 }))
  const res = await mergeWriteJson(f, { b: 2 })
  assert.equal(res.backup, f + '.bak')
  assert.equal(res.created, false)
  assert.deepEqual(JSON.parse(await readFile(f + '.bak', 'utf8')), { a: 1 })
})

test('mergeWriteJson creates the file with $schema and reports created', async () => {
  const d = await tmp()
  const f = join(d, 'opencode.json')
  const res = await mergeWriteJson(f, { model: 'openrouter/x' }, { schemaUrl: 'https://opencode.ai/config.json' })
  assert.equal(res.created, true)
  assert.equal(res.backup, null)
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.equal(out.$schema, 'https://opencode.ai/config.json')
  assert.equal(out.model, 'openrouter/x')
})

test('mergeWriteJson does not add $schema to an existing file that lacks it', async () => {
  const d = await tmp()
  const f = join(d, 'opencode.json')
  await writeFile(f, JSON.stringify({ model: 'a/b' }))
  await mergeWriteJson(f, { model: 'c/d' }, { schemaUrl: 'https://opencode.ai/config.json' })
  const out = JSON.parse(await readFile(f, 'utf8'))
  assert.equal(out.$schema, undefined)
  assert.equal(out.model, 'c/d')
})
