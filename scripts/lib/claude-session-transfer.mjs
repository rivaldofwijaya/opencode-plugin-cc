import { join } from 'node:path'
import { access, readFile } from 'node:fs/promises'
import { stateRoot, ensureDir } from './state.mjs'
import { atomicWrite } from './fs.mjs'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function transcriptPath({ env = process.env, ccSessionId, cwd }) {
  const explicit = env.CLAUDE_TRANSCRIPT_PATH
  if (explicit && await exists(explicit)) return explicit

  const home = env.HOME
  if (!home) return null
  const slug = String(cwd ?? '').replaceAll('/', '-').replaceAll('.', '-')
  const candidate = join(home, '.claude', 'projects', slug, `${ccSessionId}.jsonl`)
  return (await exists(candidate)) ? candidate : null
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

function unreadableTranscriptError(path, error) {
  const wrapped = new Error(`could not read Claude Code transcript ${path}: ${error.message}`)
  wrapped.code = error.code
  wrapped.cause = error
  wrapped.transferKind = 'unreadable'
  return wrapped
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

  if (!source.length) {
    return header + '(The transcript contained no conversation content.)\n'
  }

  const sections = source.map((message) => (
    `## ${String(message?.role ?? 'unknown')}\n\n${String(message?.text ?? '')}\n`
  ))
  const requestedMax = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 120_000
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

  return header + marker + kept.join('\n')
}

function safeFileComponent(value) {
  const component = String(value ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_')
  return component || 'default'
}

export async function writeHandoff({ text, ccSessionId, env = process.env }) {
  const dir = join(stateRoot(env), 'transfers')
  await ensureDir(dir)
  const path = join(dir, `${safeFileComponent(ccSessionId)}-${Date.now()}.md`)
  await atomicWrite(path, String(text))
  return path
}
