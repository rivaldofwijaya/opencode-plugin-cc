import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, realpath, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../scripts/lib/process.mjs'
import { repoRoot, defaultBase, resolveScope, sizeChange, collectDiff } from '../../scripts/lib/git.mjs'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
}

async function envWithFailingGit(command) {
  const bin = await mkdtemp(join(tmpdir(), 'ocgit-bin-'))
  const wrapper = join(bin, 'git')
  await writeFile(wrapper, `#!/bin/sh
if [ "$1" = "${command}" ]; then
  echo "forced ${command} failure" >&2
  exit 42
fi
PATH="$OC_GIT_REAL_PATH" exec git "$@"
`)
  await chmod(wrapper, 0o755)
  return {
    ...gitEnv,
    PATH: `${bin}:${gitEnv.PATH ?? ''}`,
    OC_GIT_REAL_PATH: gitEnv.PATH ?? '',
  }
}

async function repo({ commit = true } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ocgit-')))
  const git = (...args) => run('git', args, { cwd: dir, env: gitEnv })
  await git('init', '-b', 'main')
  if (commit) {
    await writeFile(join(dir, 'a.txt'), 'one\n')
    await git('add', '.')
    await git('commit', '-m', 'init')
  }
  return { dir, git }
}

test('repoRoot resolves the repository and rejects outside a repo', async () => {
  const r = await repo()
  assert.equal(await repoRoot(r.dir), r.dir)
  const nested = join(r.dir, 'nested')
  await mkdir(nested)
  assert.equal(await repoRoot(nested), r.dir)

  const bare = await mkdtemp(join(tmpdir(), 'ocnogit-'))
  await assert.rejects(() => repoRoot(bare), /not a git repository/)
})

test('sizeChange reports a clean tree as empty but not tiny', async () => {
  const r = await repo()
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, true)
  assert.equal(s.tiny, false)
  assert.deepEqual(s.untracked, [])
})

test('sizeChange counts modified tracked files', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'a.txt'), 'one\ntwo\n')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, false)
  assert.equal(s.files, 1)
  assert.equal(s.insertions, 1)
  assert.equal(s.tiny, true)
})

test('untracked files alone are not empty', async () => {
  const r = await repo()
  const path = 'new file-é.txt'
  await writeFile(join(r.dir, path), 'hello\n')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, false)
  assert.deepEqual(s.untracked, [path])
})

test('an untracked directory is not tiny', async () => {
  const r = await repo()
  await mkdir(join(r.dir, 'pkg', 'sub'), { recursive: true })
  await writeFile(join(r.dir, 'pkg', 'x.txt'), 'x\n')
  await writeFile(join(r.dir, 'pkg', 'sub', 'y.txt'), 'y\n')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.tiny, false)
})

test('sizeChange counts staged changes', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'a.txt'), 'one\ntwo\n')
  await r.git('add', 'a.txt')
  const s = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(s.empty, false)
  assert.equal(s.insertions, 1)
})

test('sizeChange reports a git status failure instead of an empty result', async () => {
  const r = await repo()
  const env = await envWithFailingGit('status')
  await assert.rejects(
    () => sizeChange({ cwd: r.dir, scope: 'working-tree', base: null, env }),
    /git status --short --untracked-files=all -z exited with code 42: forced status failure/,
  )
})

test('resolveScope picks branch when HEAD is ahead of base', async () => {
  const r = await repo()
  await r.git('branch', 'base-ref')
  await writeFile(join(r.dir, 'b.txt'), 'b\n')
  await r.git('add', '.')
  await r.git('commit', '-m', 'second')
  assert.deepEqual(
    await resolveScope({ cwd: r.dir, scope: 'auto', base: 'base-ref' }),
    { scope: 'branch', base: 'base-ref' },
  )
})

test('resolveScope picks working-tree when HEAD is not ahead', async () => {
  const r = await repo()
  const s = await resolveScope({ cwd: r.dir, scope: 'auto', base: 'HEAD' })
  assert.deepEqual(s, { scope: 'working-tree', base: null })
})

test('resolveScope reports a rev-list failure instead of falling back', async () => {
  const r = await repo()
  await assert.rejects(
    () => resolveScope({ cwd: r.dir, scope: 'auto', base: 'missing-base' }),
    /git rev-list --count missing-base\.\.HEAD exited with code \d+: .*unknown revision|invalid revision/,
  )
})

test('an explicit scope is obeyed without inspecting the repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocscope-'))
  assert.deepEqual(
    await resolveScope({ cwd: dir, scope: 'working-tree', base: 'not-a-ref' }),
    { scope: 'working-tree', base: null },
  )
  assert.deepEqual(
    await resolveScope({ cwd: dir, scope: 'branch', base: 'HEAD' }),
    { scope: 'branch', base: 'HEAD' },
  )
})

test('defaultBase handles local main, detached HEAD, and an empty repository', async () => {
  const r = await repo()
  assert.equal(await defaultBase(r.dir), 'main')
  await r.git('checkout', '--detach', 'HEAD')
  assert.equal(await defaultBase(r.dir), 'main')

  const empty = await repo({ commit: false })
  assert.equal(await defaultBase(empty.dir), 'HEAD')
  assert.deepEqual(await resolveScope({ cwd: empty.dir, scope: 'auto' }), {
    scope: 'working-tree',
    base: null,
  })
})

test('collectDiff includes tracked changes and untracked file contents', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'a.txt'), 'one\ntwo\n')
  const path = 'new file-é.txt'
  await writeFile(join(r.dir, path), 'brand new\n')
  const d = await collectDiff({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.match(d.text, /\+two/)
  assert.match(d.text, /--- untracked: new file-é\.txt/)
  assert.match(d.text, /brand new/)
  assert.equal(d.truncated, false)
})

test('unborn repositories and untracked-only trees remain successful', async () => {
  const r = await repo({ commit: false })
  const path = 'new.txt'
  await writeFile(join(r.dir, path), 'new\n')

  const size = await sizeChange({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.equal(size.empty, false)
  assert.deepEqual(size.untracked, [path])

  const diff = await collectDiff({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.match(diff.text, /--- untracked: new\.txt/)
  assert.match(diff.text, /new\n/)
})

test('collectDiff is byte-accurate around the 64 KiB boundary', async () => {
  const r = await repo()
  await writeFile(join(r.dir, 'a.txt'), `${'é'.repeat(200)}\n`)
  await writeFile(join(r.dir, 'exact.bin'), Buffer.alloc(64 * 1024, 0x78))
  const under = 'u'.repeat(64 * 1024 - 1)
  await writeFile(join(r.dir, 'under.bin'), under)

  const full = await collectDiff({ cwd: r.dir, scope: 'working-tree', base: null })
  assert.match(full.text, /--- untracked: exact\.bin/)
  assert.match(full.text, /\(65536 bytes, omitted\)/)
  assert.ok(full.text.includes(`--- untracked: under.bin\n${under}`))

  const limited = await collectDiff({ cwd: r.dir, scope: 'working-tree', base: null, maxBytes: 120 })
  assert.equal(limited.truncated, true)
  assert.ok(Buffer.byteLength(limited.text) <= 120)
})

test('collectDiff on a branch scope diffs against the merge base', async () => {
  const r = await repo()
  await r.git('branch', 'base-ref')
  await r.git('checkout', '-b', 'feature')
  await writeFile(join(r.dir, 'feature.txt'), 'feature\n')
  await r.git('add', '.')
  await r.git('commit', '-m', 'feature')
  await r.git('checkout', 'base-ref')
  await writeFile(join(r.dir, 'base.txt'), 'base\n')
  await r.git('add', '.')
  await r.git('commit', '-m', 'base')
  await r.git('checkout', 'feature')

  const d = await collectDiff({ cwd: r.dir, scope: 'branch', base: 'base-ref' })
  assert.match(d.text, /feature\.txt/)
  assert.doesNotMatch(d.text, /base\.txt/)
})

test('collectDiff reports a branch diff failure instead of returning empty', async () => {
  const r = await repo()
  await assert.rejects(
    () => collectDiff({ cwd: r.dir, scope: 'branch', base: 'missing-base' }),
    /git diff missing-base\.\.\.HEAD exited with code \d+: .*unknown revision|invalid revision/,
  )
})
