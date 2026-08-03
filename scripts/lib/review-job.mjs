import { resolveScope, sizeChange, collectDiff, repoRoot } from './git.mjs'
import { loadPrompt } from './prompts.mjs'
import { readResult } from './tracked-jobs.mjs'
import { parseReviewOutput } from './review-schema.mjs'
import { renderReview } from './render.mjs'
import { CompanionError } from './doctor.mjs'

export const REVIEW_AGENT = 'opencode-review'

export const REVIEW_TOOLS = {
  read: true, grep: true, glob: true, list: true,
  edit: false, write: false, patch: false, bash: false, webfetch: false,
}

export async function prepareReview({ cwd, scope = 'auto', base, adversarial = false, focus = '' }) {
  const root = await repoRoot(cwd).catch(() => { throw new CompanionError(`not a git repository: ${cwd}`) })
  const resolved = await resolveScope({ cwd: root, scope, base })
  const size = await sizeChange({ cwd: root, scope: resolved.scope, base: resolved.base })
  if (size.empty) {
    throw new CompanionError(
      `There is nothing to review: the ${resolved.scope === 'branch' ? `branch diff against ${resolved.base}` : 'working tree'} is empty.`,
    )
  }
  const diff = await collectDiff({ cwd: root, scope: resolved.scope, base: resolved.base })
  const vars = {
    CWD: root,
    SCOPE: resolved.scope,
    BASE_NOTE: resolved.base ? ` (against ${resolved.base})` : '',
    DIFF: diff.text,
  }
  const prompt = adversarial
    ? await loadPrompt('adversarial-review', { ...vars, FOCUS: focus.trim() || '(none given)' })
    : await loadPrompt('review', vars)
  return { prompt, root, scope: resolved.scope, base: resolved.base, size, truncated: diff.truncated }
}

export async function finishReview({ jobId, env, scope, base, truncated }) {
  const text = await readResult(jobId, env)
  const parsed = parseReviewOutput(text ?? '')
  return renderReview(parsed, { scope, base, truncated, jobId })
}
