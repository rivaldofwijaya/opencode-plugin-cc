import { randomBytes } from 'node:crypto'
import { resolveScope, sizeChange, collectDiff, repoRoot } from './git.mjs'
import { loadPrompt } from './prompts.mjs'
import { readJob, readResult } from './tracked-jobs.mjs'
import { parseReviewOutput } from './review-schema.mjs'
import { renderReview } from './render.mjs'
import { CompanionError } from './doctor.mjs'

export const REVIEW_AGENT = 'opencode-review'

export const REVIEW_TOOLS = {
  read: true, grep: true, glob: true, list: true,
  edit: false, write: false, patch: false, bash: false, webfetch: false,
}

export function neutralizePromptDelimiters(value) {
  return String(value).replaceAll('<', '＜').replaceAll('>', '＞')
}

export async function prepareReview({
  cwd,
  scope = 'auto',
  base,
  adversarial = false,
  focus = '',
  promptName = 'review',
}) {
  const root = await repoRoot(cwd).catch(() => { throw new CompanionError(`not a git repository: ${cwd}`) })
  const resolved = await resolveScope({ cwd: root, scope, base })
  const size = await sizeChange({ cwd: root, scope: resolved.scope, base: resolved.base })
  if (size.empty) {
    throw new CompanionError(
      `There is nothing to review: the ${resolved.scope === 'branch' ? `branch diff against ${resolved.base}` : 'working tree'} is empty.`,
    )
  }
  const diff = await collectDiff({ cwd: root, scope: resolved.scope, base: resolved.base })
  const nonce = randomBytes(16).toString('hex')
  const openDelimiter = `<change-${nonce}>`
  const closeDelimiter = `</change-${nonce}>`
  const vars = {
    CWD: neutralizePromptDelimiters(root),
    SCOPE: neutralizePromptDelimiters(resolved.scope),
    BASE_NOTE: neutralizePromptDelimiters(resolved.base ? ` (against ${resolved.base})` : ''),
    DIFF: `${openDelimiter}\n${diff.text}\n${closeDelimiter}`,
  }
  const focusText = typeof focus === 'string' ? focus.trim() : String(focus ?? '').trim()
  const prompt = await loadPrompt(adversarial ? 'adversarial-review' : promptName, {
      ...vars,
      ...(adversarial ? { FOCUS: neutralizePromptDelimiters(focusText || '(none given)') } : {}),
    })
  return { prompt, root, scope: resolved.scope, base: resolved.base, size, truncated: diff.truncated }
}

export async function finishReview({ jobId, env, scope, base, truncated }) {
  return (await finishReviewResult({ jobId, env, scope, base, truncated })).rendered
}

export async function finishReviewResult({ jobId, env, scope, base, truncated }) {
  const text = await readResult(jobId, env)
  const job = await readJob(jobId, env)
  const parsed = parseReviewOutput(text ?? '')
  const metadata = job?.meta ?? {}
  const effectiveScope = scope ?? metadata.scope ?? 'working-tree'
  const effectiveBase = base ?? metadata.base ?? null
  const effectiveTruncated = truncated ?? metadata.truncated ?? false
  return {
    rendered: renderReview(parsed, {
      scope: effectiveScope,
      base: effectiveBase,
      truncated: effectiveTruncated,
      jobId,
    }),
    ok: parsed.ok,
  }
}
