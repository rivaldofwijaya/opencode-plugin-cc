import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { run } from './process.mjs'

const DEFAULT_TIMEOUT_MS = 30_000
const DIFF_TIMEOUT_MS = 60_000
const MAX_UNTRACKED_BYTES = 64 * 1024
const TRUNCATION_MARKER = '\n\n[diff truncated]\n'

async function git(args, { cwd = process.cwd(), env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return run('git', args, { cwd, env, timeoutMs })
}

export async function repoRoot(cwd = process.cwd()) {
  const result = await git(['rev-parse', '--show-toplevel'], { cwd })
  if (result.code !== 0) throw new Error(`not a git repository: ${cwd}`)
  return result.stdout.trim()
}

async function refExists(cwd, ref) {
  const result = await git(['rev-parse', '--verify', '--quiet', ref], { cwd })
  return result.code === 0
}

export async function defaultBase(cwd = process.cwd()) {
  const upstream = await git(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd },
  )
  if (upstream.code === 0 && upstream.stdout.trim()) return upstream.stdout.trim()

  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(cwd, ref)) return ref
  }
  return 'HEAD'
}

export async function resolveScope({ cwd = process.cwd(), scope = 'auto', base = null } = {}) {
  if (scope === 'working-tree') return { scope: 'working-tree', base: null }
  if (scope !== 'auto' && scope !== 'branch') {
    throw new Error(`scope must be auto, working-tree, or branch, got: ${scope}`)
  }

  const resolvedBase = base ?? await defaultBase(cwd)
  if (scope === 'branch') return { scope: 'branch', base: resolvedBase }

  const result = await git(['rev-list', '--count', `${resolvedBase}..HEAD`], { cwd })
  const count = Number(result.stdout.trim())
  if (result.code === 0 && Number.isFinite(count) && count > 0) {
    return { scope: 'branch', base: resolvedBase }
  }
  return { scope: 'working-tree', base: null }
}

function parseShortstat(text) {
  const files = Number(text.match(/(\d+) files? changed/)?.[1] ?? 0)
  const insertions = Number(text.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0)
  const deletions = Number(text.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0)
  return { files, insertions, deletions }
}

async function untrackedPaths(cwd) {
  const result = await git(
    ['status', '--short', '--untracked-files=all', '-z'],
    { cwd },
  )
  if (result.code !== 0) return []

  return result.stdout
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
    .filter((path) => path.length > 0)
}

async function workingTreeStats(cwd) {
  const result = await git(['diff', '--shortstat', 'HEAD'], { cwd })
  if (result.code === 0) return parseShortstat(result.stdout)

  // An unborn HEAD cannot be used as a diff endpoint. The two diffs are only
  // a fallback for that state; a repository with a commit uses the unique
  // tracked-file stats from `git diff HEAD` above.
  const staged = await git(['diff', '--shortstat', '--cached'], { cwd })
  const unstaged = await git(['diff', '--shortstat'], { cwd })
  return {
    files: Math.max(parseShortstat(staged.stdout).files, parseShortstat(unstaged.stdout).files),
    insertions: parseShortstat(staged.stdout).insertions + parseShortstat(unstaged.stdout).insertions,
    deletions: parseShortstat(staged.stdout).deletions + parseShortstat(unstaged.stdout).deletions,
  }
}

export async function sizeChange({ cwd = process.cwd(), scope = 'working-tree', base = null } = {}) {
  let stats
  if (scope === 'branch') {
    const resolvedBase = base ?? await defaultBase(cwd)
    const result = await git(['diff', '--shortstat', `${resolvedBase}...HEAD`], { cwd })
    stats = parseShortstat(result.stdout)
  } else if (scope === 'working-tree') {
    stats = await workingTreeStats(cwd)
  } else {
    throw new Error(`scope must be working-tree or branch, got: ${scope}`)
  }

  const untracked = await untrackedPaths(cwd)
  const empty = stats.files === 0
    && stats.insertions === 0
    && stats.deletions === 0
    && untracked.length === 0
  // A clean tree is not tiny: it has no reviewable work to size.
  const tiny = !empty
    && stats.files + untracked.length <= 2
    && !untracked.some((path) => path.includes('/'))

  return { ...stats, untracked, empty, tiny }
}

async function trackedDiff(cwd, scope, base) {
  if (scope === 'branch') {
    const resolvedBase = base ?? await defaultBase(cwd)
    const result = await git(['diff', `${resolvedBase}...HEAD`], { cwd, timeoutMs: DIFF_TIMEOUT_MS })
    return result.code === 0 ? result.stdout : ''
  }
  if (scope !== 'working-tree') {
    throw new Error(`scope must be working-tree or branch, got: ${scope}`)
  }

  const result = await git(['diff', 'HEAD'], { cwd, timeoutMs: DIFF_TIMEOUT_MS })
  if (result.code === 0) return result.stdout

  // An unborn HEAD has no revision to compare against. Preserve both staged
  // and unstaged tracked output in that exceptional state.
  const staged = await git(['diff', '--cached'], { cwd, timeoutMs: DIFF_TIMEOUT_MS })
  const unstaged = await git(['diff'], { cwd, timeoutMs: DIFF_TIMEOUT_MS })
  return `${staged.code === 0 ? staged.stdout : ''}${unstaged.code === 0 ? unstaged.stdout : ''}`
}

async function untrackedSection(cwd, path) {
  let file
  try {
    file = await stat(join(cwd, path))
  } catch (error) {
    if (error.code === 'ENOENT') return '(unreadable: ENOENT)\n'
    throw error
  }

  if (!file.isFile()) return '(not a regular file, omitted)\n'
  if (file.size >= MAX_UNTRACKED_BYTES) return `(${file.size} bytes, omitted)\n`

  let contents
  try {
    contents = await readFile(join(cwd, path))
  } catch (error) {
    if (error.code === 'ENOENT') return '(unreadable: ENOENT)\n'
    throw error
  }
  if (contents.byteLength >= MAX_UNTRACKED_BYTES) return `(${contents.byteLength} bytes, omitted)\n`
  if (contents.includes(0)) return '(binary, omitted)\n'
  return contents.toString('utf8')
}

function truncateUtf8(text, maxBytes) {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 400_000
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER)
  if (limit <= markerBytes) {
    return {
      text: Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8'),
      truncated: true,
    }
  }

  const prefix = Buffer.from(text, 'utf8').subarray(0, limit - markerBytes).toString('utf8')
  return { text: prefix + TRUNCATION_MARKER, truncated: true }
}

export async function collectDiff({
  cwd = process.cwd(),
  scope = 'working-tree',
  base = null,
  maxBytes = 400_000,
} = {}) {
  let text = await trackedDiff(cwd, scope, base)
  for (const path of await untrackedPaths(cwd)) {
    text += `\n--- untracked: ${path}\n`
    text += await untrackedSection(cwd, path)
  }
  return truncateUtf8(text, maxBytes)
}
