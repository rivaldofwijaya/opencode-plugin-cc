import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { access, readFile } from 'node:fs/promises'
import { stateRoot, ensureDir } from './state.mjs'
import { atomicWrite } from './fs.mjs'

const MAX_CC_SESSION_ID_LENGTH = 128
const CC_SESSION_ID_PATTERN = /^[A-Fa-f0-9_-]+$/

export function validateCcSessionId(value) {
  const id = typeof value === 'string' ? value : ''
  if (
    !id
    || id.length > MAX_CC_SESSION_ID_LENGTH
    || !CC_SESSION_ID_PATTERN.test(id)
  ) {
    const error = new Error(
      `invalid Claude Code session id: expected 1-${MAX_CC_SESSION_ID_LENGTH} hexadecimal, dash, or underscore characters`,
    )
    error.code = 'INVALID_SESSION_ID'
    error.transferKind = 'invalid-session-id'
    throw error
  }
  return id
}

function unreadableTranscriptError(path, error, operation = 'read') {
  const wrapped = new Error(`could not ${operation} Claude Code transcript ${path}: ${error.message}`)
  wrapped.code = error.code
  wrapped.cause = error
  wrapped.path = path
  wrapped.transferKind = 'unreadable'
  return wrapped
}

async function exists(path, accessFn = access) {
  try {
    await accessFn(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw unreadableTranscriptError(path, error, 'access')
  }
}

function isWithin(root, path) {
  const distance = relative(root, path)
  return distance === '' || (
    !isAbsolute(distance)
    && distance !== '..'
    && !distance.startsWith(`..${sep}`)
  )
}

export function resolveContainedPath(root, segments, {
  code = 'PATH_OUTSIDE_ROOT',
  transferKind = 'invalid-path',
  label = 'path',
} = {}) {
  const rootPath = resolve(root)
  const candidate = resolve(rootPath, ...(Array.isArray(segments) ? segments : [segments]))
  if (!isWithin(rootPath, candidate)) {
    const error = new Error(`refusing ${label} outside ${rootPath}: ${candidate}`)
    error.code = code
    error.transferKind = transferKind
    error.path = candidate
    throw error
  }
  return candidate
}

export function transcriptCandidatePath({ projectsRoot, slug, ccSessionId }) {
  return resolveContainedPath(projectsRoot, [slug, `${String(ccSessionId)}.jsonl`], {
    code: 'TRANSCRIPT_PATH_OUTSIDE_PROJECTS',
    transferKind: 'invalid-transcript-path',
    label: 'Claude Code transcript path',
  })
}

export function handoffPath({ env = process.env, ccSessionId, timestamp = Date.now() }) {
  const root = stateRoot(env)
  return resolveContainedPath(root, ['transfers', `${String(ccSessionId)}-${timestamp}.md`], {
    code: 'HANDOFF_PATH_OUTSIDE_STATE',
    transferKind: 'invalid-handoff-path',
    label: 'Claude Code handoff path',
  })
}

// Validated session ids contain only characters that encodeURIComponent leaves
// unchanged, so this is the same filename component used by tracked-jobs.mjs.
export function persistedSessionPath({ env = process.env, ccSessionId }) {
  const root = stateRoot(env)
  return resolveContainedPath(root, ['sessions', `${String(ccSessionId)}.json`], {
    code: 'PERSISTED_SESSION_PATH_OUTSIDE_STATE',
    transferKind: 'invalid-persisted-session-path',
    label: 'persisted Claude Code session path',
  })
}

export async function transcriptPath({ env = process.env, ccSessionId, cwd, accessFn = access }) {
  const sessionId = validateCcSessionId(ccSessionId)
  const explicit = env.CLAUDE_TRANSCRIPT_PATH
  if (explicit && await exists(explicit, accessFn)) return explicit

  const home = env.HOME
  if (!home) return null
  const slug = String(cwd ?? '').replaceAll('/', '-').replaceAll('.', '-')
  const projectsRoot = resolve(home, '.claude', 'projects')
  const candidate = transcriptCandidatePath({ projectsRoot, slug, ccSessionId: sessionId })
  return (await exists(candidate, accessFn)) ? candidate : null
}

function flattenContent(content) {
  if (typeof content === 'string') return { text: content, droppedParts: 0 }
  if (!Array.isArray(content)) return { text: '', droppedParts: 0 }

  let droppedParts = 0
  const text = content
    .filter((part) => {
      const keep = part?.type === 'text' && typeof part.text === 'string'
      if (!keep) droppedParts += 1
      return keep
    })
    .map((part) => part.text)
    .join('\n')
    .trim()
  return { text, droppedParts }
}

/**
 * Read with omission accounting so the companion can distinguish a complete
 * export from one that had malformed lines, unknown entries, or tool parts.
 */
export async function readTranscriptReport(path) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw unreadableTranscriptError(path, error)
  }

  const report = {
    messages: [],
    malformedLines: 0,
    ignoredEntries: 0,
    droppedParts: 0,
    empty: source.trim().length === 0,
  }

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue

    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      report.malformedLines += 1
      continue
    }

    if (entry?.type !== 'user' && entry?.type !== 'assistant') {
      report.ignoredEntries += 1
      continue
    }

    const flattened = flattenContent(entry?.message?.content)
    report.droppedParts += flattened.droppedParts
    if (!flattened.text) {
      report.ignoredEntries += 1
      continue
    }
    report.messages.push({ role: entry.type, text: flattened.text })
  }

  return report
}

export async function readTranscript(path) {
  return (await readTranscriptReport(path)).messages
}

function handoffHeader({ cwd, ccSessionId }) {
  return [
    '# Handoff from Claude Code',
    '',
    `Repository: ${String(cwd ?? '')}`,
    `Claude Code session: ${String(ccSessionId ?? '')}`,
    '',
    'This is a one-way export of a Claude Code conversation. Read it, then continue',
    'the work it describes in this opencode session. The Claude Code side is not',
    'listening — nothing you write here goes back to it.',
    '',
    'Security notice: this export applies no secret redaction or content filtering.',
    'API keys, tokens, pasted file contents, tool output, and other sensitive text',
    'in the transcript may be included and sent to opencode. Only prompt-delimiter',
    'characters are neutralized in the transmitted prompt wrapper.',
    '',
    'Only user/assistant text parts are included. Tool calls, tool results, system',
    'entries, malformed lines, and unknown transcript shapes may be omitted; the',
    'companion reports omissions separately when it performs the transfer.',
    '',
    '---',
    '',
  ].join('\n')
}

export function buildHandoff({ messages, cwd, ccSessionId, maxChars = 120_000 }) {
  const header = handoffHeader({ cwd, ccSessionId })
  const source = Array.isArray(messages) ? messages : []
  const requestedMax = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 120_000

  if (!source.length) {
    return (header + '(The transcript contained no conversation content.)\n').slice(0, requestedMax)
  }

  const sections = source.map((message) => (
    `## ${String(message?.role ?? 'unknown')}\n\n${String(message?.text ?? '')}\n`
  ))
  const kept = []
  let used = 0
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (used + sections[index].length > Math.max(0, requestedMax - header.length)) break
    kept.unshift(sections[index])
    used += sections[index].length
  }

  let omitted = sections.length - kept.length
  let marker = omitted > 0 ? `_[${omitted} earlier turns omitted to fit the handoff]_\n\n` : ''
  while (header.length + marker.length + kept.join('\n').length > requestedMax && kept.length) {
    kept.shift()
    omitted += 1
    marker = `_[${omitted} earlier turns omitted to fit the handoff]_\n\n`
  }

  const output = header + marker + kept.join('\n')
  return output.length <= requestedMax ? output : output.slice(0, requestedMax)
}

export async function writeHandoff({ text, ccSessionId, env = process.env }) {
  const sessionId = validateCcSessionId(ccSessionId)
  const dir = join(stateRoot(env), 'transfers')
  const path = handoffPath({ env, ccSessionId: sessionId })
  await ensureDir(dir)
  await atomicWrite(path, String(text))
  return path
}
