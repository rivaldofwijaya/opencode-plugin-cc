import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { run } from './process.mjs'

const DEFAULT_TIMEOUT_MS = 30_000
const DIFF_TIMEOUT_MS = 60_000
const MAX_UNTRACKED_BYTES = 64 * 1024
const TRUNCATION_MARKER = '\n\n[diff truncated]\n'

async function git(args, { cwd = process.cwd(), env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return run('git', args, {
    cwd,
    env: { ...env, LC_ALL: 'C', LANG: 'C' },
    timeoutMs,
  })
}

function gitCommand(args) {
  return `git ${args.join(' ')}`
}

function gitFailure(args, result) {
  const outcome = result.timedOut
    ? 'timed out'
    : `exited with code ${result.code ?? 'unknown'}`
  const stderr = result.stderr.trim()
  return new Error(`${gitCommand(args)} ${outcome}${stderr ? `: ${stderr}` : ''}`)
}

function requireGitSuccess(args, result) {
  if (result.timedOut || result.code !== 0) throw gitFailure(args, result)
  return result
}

function unparseableGitOutput(args, output) {
  return new Error(`${gitCommand(args)} returned unparseable output: ${JSON.stringify(output)}`)
}

function noBaseCandidate() {
  return new Error('no base candidate exists; pass --base')
}

function isUnbornDiffFailure(result) {
  if (result.code !== 128) return false
  const stderr = result.stderr.trim()
  return stderr.includes("ambiguous argument 'HEAD':")
    || stderr.includes("bad revision 'HEAD'")
}

export async function repoRoot(cwd = process.cwd(), env = process.env) {
  const args = ['rev-parse', '--show-toplevel']
  const result = requireGitSuccess(args, await git(args, { cwd, env }))
  const root = result.stdout.trim()
  if (root === '') throw unparseableGitOutput(args, result.stdout)
  return root
}

async function refExists(cwd, ref, env) {
  const args = ['rev-parse', '--verify', '--quiet', ref]
  const result = await git(args, { cwd, env })
  if (result.code === 0 && !result.timedOut) return true
  if (!result.timedOut && result.code === 1) return false
  throw gitFailure(args, result)
}

export async function defaultBase(cwd = process.cwd(), env = process.env) {
  const branchArgs = ['branch', '--show-current']
  const branchResult = requireGitSuccess(branchArgs, await git(branchArgs, { cwd, env }))
  const branch = branchResult.stdout.trim()
  if (branch !== '') {
    const upstreamArgs = ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`]
    const upstream = requireGitSuccess(upstreamArgs, await git(upstreamArgs, { cwd, env }))
    const resolved = upstream.stdout.trim()
    if (resolved !== '') return resolved
  }

  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(cwd, ref, env)) return ref
  }
  // null is deliberate: callers must handle the absence of a safe diff base.
  return null
}

async function isUnbornRepository(cwd, env) {
  const headArgs = ['rev-parse', '--verify', '--quiet', 'HEAD']
  const head = await git(headArgs, { cwd, env })
  if (head.timedOut) throw gitFailure(headArgs, head)
  if (head.code === 0) return false
  if (head.code !== 1) throw gitFailure(headArgs, head)

  const statusArgs = ['status', '--short', '--untracked-files=no']
  const status = await git(statusArgs, { cwd, env })
  requireGitSuccess(statusArgs, status)
  return true
}

export async function resolveScope({ cwd = process.cwd(), scope = 'auto', base = null, env = process.env } = {}) {
  if (scope === 'working-tree') return { scope: 'working-tree', base: null }
  if (scope !== 'auto' && scope !== 'branch') {
    throw new Error(`scope must be auto, working-tree, or branch, got: ${scope}`)
  }

  const resolvedBase = base ?? await defaultBase(cwd, env)
  if (resolvedBase === null) {
    if (scope === 'auto' && await isUnbornRepository(cwd, env)) {
      return { scope: 'working-tree', base: null }
    }
    throw noBaseCandidate()
  }
  if (scope === 'branch') return { scope: 'branch', base: resolvedBase }

  if (resolvedBase === 'HEAD' && await isUnbornRepository(cwd, env)) {
    return { scope: 'working-tree', base: null }
  }

  const args = ['rev-list', '--count', `${resolvedBase}..HEAD`]
  const result = requireGitSuccess(args, await git(args, { cwd, env }))
  const rawCount = result.stdout.trim()
  if (!/^\d+$/.test(rawCount)) throw unparseableGitOutput(args, result.stdout)
  const count = Number(rawCount)
  if (!Number.isSafeInteger(count)) throw unparseableGitOutput(args, result.stdout)
  if (count > 0) {
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

function parseShortstatOutput(args, text) {
  if (text.trim() !== '' && !/^\s*\d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?\s*$/.test(text)) {
    throw unparseableGitOutput(args, text)
  }
  return parseShortstat(text)
}

function parseStatusOutput(args, text) {
  const entries = text.split('\0')
  if (entries.at(-1) === '') entries.pop()

  const paths = []
  let renameSource = false
  for (const entry of entries) {
    if (renameSource) {
      if (entry.length === 0) throw unparseableGitOutput(args, text)
      renameSource = false
      continue
    }

    const match = /^([ MADRCUT?!]{2}) ([\s\S]+)$/.exec(entry)
    if (!match) throw unparseableGitOutput(args, text)

    const status = match[1]
    if (status === '??') paths.push(match[2])
    if (status.includes('R') || status.includes('C')) renameSource = true
  }
  if (renameSource) throw unparseableGitOutput(args, text)
  return paths
}

async function untrackedPaths(cwd, env) {
  const args = ['status', '--short', '--untracked-files=all', '-z']
  const result = requireGitSuccess(args, await git(args, { cwd, env }))

  return parseStatusOutput(args, result.stdout)
}

async function workingTreeStats(cwd, env) {
  const args = ['diff', '--shortstat', 'HEAD']
  const result = await git(args, { cwd, env })
  if (result.code === 0 && !result.timedOut) return parseShortstatOutput(args, result.stdout)
  if (result.timedOut) throw gitFailure(args, result)
  if (!isUnbornDiffFailure(result)) throw gitFailure(args, result)
  if (!(await isUnbornRepository(cwd, env))) throw gitFailure(args, result)

  // An unborn HEAD cannot be used as a diff endpoint. The two diffs are only
  // a fallback for that state; a repository with a commit uses the unique
  // tracked-file stats from `git diff HEAD` above.
  const stagedArgs = ['diff', '--shortstat', '--cached']
  const unstagedArgs = ['diff', '--shortstat']
  const staged = requireGitSuccess(stagedArgs, await git(stagedArgs, { cwd, env }))
  const unstaged = requireGitSuccess(unstagedArgs, await git(unstagedArgs, { cwd, env }))
  return {
    files: Math.max(parseShortstatOutput(stagedArgs, staged.stdout).files, parseShortstatOutput(unstagedArgs, unstaged.stdout).files),
    insertions: parseShortstatOutput(stagedArgs, staged.stdout).insertions + parseShortstatOutput(unstagedArgs, unstaged.stdout).insertions,
    deletions: parseShortstatOutput(stagedArgs, staged.stdout).deletions + parseShortstatOutput(unstagedArgs, unstaged.stdout).deletions,
  }
}

export async function sizeChange({ cwd = process.cwd(), scope = 'working-tree', base = null, env = process.env } = {}) {
  let stats
  if (scope === 'branch') {
    const resolvedBase = base ?? await defaultBase(cwd, env)
    if (resolvedBase === null) throw noBaseCandidate()
    if (resolvedBase === 'HEAD' && await isUnbornRepository(cwd, env)) {
      stats = { files: 0, insertions: 0, deletions: 0 }
    } else {
      const args = ['diff', '--shortstat', `${resolvedBase}...HEAD`]
      const result = requireGitSuccess(args, await git(args, { cwd, env }))
      stats = parseShortstatOutput(args, result.stdout)
    }
  } else if (scope === 'working-tree') {
    stats = await workingTreeStats(cwd, env)
  } else {
    throw new Error(`scope must be working-tree or branch, got: ${scope}`)
  }

  const untracked = await untrackedPaths(cwd, env)
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

async function trackedDiff(cwd, scope, base, env) {
  if (scope === 'branch') {
    const resolvedBase = base ?? await defaultBase(cwd, env)
    if (resolvedBase === null) throw noBaseCandidate()
    if (resolvedBase === 'HEAD' && await isUnbornRepository(cwd, env)) return ''
    const args = ['diff', `${resolvedBase}...HEAD`]
    const result = requireGitSuccess(args, await git(args, { cwd, env, timeoutMs: DIFF_TIMEOUT_MS }))
    return result.stdout
  }
  if (scope !== 'working-tree') {
    throw new Error(`scope must be working-tree or branch, got: ${scope}`)
  }

  const args = ['diff', 'HEAD']
  const result = await git(args, { cwd, env, timeoutMs: DIFF_TIMEOUT_MS })
  if (result.code === 0 && !result.timedOut) return result.stdout
  if (result.timedOut) throw gitFailure(args, result)
  if (!isUnbornDiffFailure(result)) throw gitFailure(args, result)
  if (!(await isUnbornRepository(cwd, env))) throw gitFailure(args, result)

  // An unborn HEAD has no revision to compare against. Preserve both staged
  // and unstaged tracked output in that exceptional state.
  const stagedArgs = ['diff', '--cached']
  const unstagedArgs = ['diff']
  const staged = requireGitSuccess(stagedArgs, await git(stagedArgs, { cwd, env, timeoutMs: DIFF_TIMEOUT_MS }))
  const unstaged = requireGitSuccess(unstagedArgs, await git(unstagedArgs, { cwd, env, timeoutMs: DIFF_TIMEOUT_MS }))
  return `${staged.stdout}${unstaged.stdout}`
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

  const bytes = Buffer.from(text, 'utf8')
  const utf8Prefix = (max) => {
    let prefix = bytes.subarray(0, max).toString('utf8')
    while (Buffer.byteLength(prefix) > max) prefix = prefix.slice(0, -1)
    return prefix
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER)
  if (limit <= markerBytes) {
    return {
      text: utf8Prefix(limit),
      truncated: true,
    }
  }

  const prefix = utf8Prefix(limit - markerBytes)
  return { text: prefix + TRUNCATION_MARKER, truncated: true }
}

export async function collectDiff({
  cwd = process.cwd(),
  scope = 'working-tree',
  base = null,
  maxBytes = 400_000,
  env = process.env,
} = {}) {
  let text = await trackedDiff(cwd, scope, base, env)
  for (const path of await untrackedPaths(cwd, env)) {
    text += `\n--- untracked: ${path}\n`
    text += await untrackedSection(cwd, path)
  }
  return truncateUtf8(text, maxBytes)
}
