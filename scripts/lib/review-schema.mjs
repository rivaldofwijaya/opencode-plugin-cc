export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
export const CONFIDENCES = ['high', 'medium', 'low']

const REVIEW_KEYS = new Set(['summary', 'findings'])
const FINDING_KEYS = new Set(['file', 'line', 'severity', 'confidence', 'body', 'title'])

export function extractJson(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function unknownProperty(object, allowed, location) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) return `${location} contains unknown property "${key}"`
  }
  return null
}

export function validateReview(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'review output must be a JSON object' }
  }

  const unknownReviewKey = unknownProperty(obj, REVIEW_KEYS, 'review output')
  if (unknownReviewKey) return { ok: false, error: unknownReviewKey }
  if (!Array.isArray(obj.findings)) {
    return { ok: false, error: 'review output requires a "findings" array' }
  }
  if (obj.summary !== undefined && typeof obj.summary !== 'string') {
    return { ok: false, error: '"summary" must be a string when present' }
  }

  const findings = []
  for (const [i, finding] of obj.findings.entries()) {
    const at = `findings[${i}]`
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
      return { ok: false, error: `${at} must be an object` }
    }

    const unknownFindingKey = unknownProperty(finding, FINDING_KEYS, at)
    if (unknownFindingKey) return { ok: false, error: unknownFindingKey }
    if (typeof finding.file !== 'string' || !finding.file) {
      return { ok: false, error: `${at}.file must be a non-empty string` }
    }
    if (typeof finding.body !== 'string' || !finding.body) {
      return { ok: false, error: `${at}.body must be a non-empty string` }
    }
    if (!SEVERITIES.includes(finding.severity)) {
      return { ok: false, error: `${at}.severity must be one of ${SEVERITIES.join(', ')}` }
    }
    if (!CONFIDENCES.includes(finding.confidence)) {
      return { ok: false, error: `${at}.confidence must be one of ${CONFIDENCES.join(', ')}` }
    }
    if (finding.line !== undefined && finding.line !== null
      && !(Number.isInteger(finding.line) && finding.line >= 1)) {
      return { ok: false, error: `${at}.line must be a positive integer or null` }
    }
    if (finding.title !== undefined && typeof finding.title !== 'string') {
      return { ok: false, error: `${at}.title must be a string` }
    }

    findings.push({
      file: finding.file,
      line: finding.line ?? null,
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      body: finding.body,
    })
  }
  return { ok: true, findings }
}

function failedParse(raw, error) {
  return { ok: false, findings: [], summary: null, raw, error }
}

export function parseReviewOutput(text) {
  let raw
  try {
    raw = typeof text === 'string' ? text : String(text ?? '')
  } catch (error) {
    return failedParse('', `could not read model output: ${error.message}`)
  }

  try {
    const json = extractJson(raw)
    if (!json) return failedParse(raw, 'no JSON object found in model output')

    let parsed
    try {
      parsed = JSON.parse(json)
    } catch (error) {
      return failedParse(raw, `malformed JSON: ${error.message}`)
    }

    const validation = validateReview(parsed)
    if (!validation.ok) return failedParse(raw, validation.error)
    return {
      ok: true,
      findings: validation.findings,
      summary: parsed.summary ?? null,
      raw,
      error: null,
    }
  } catch (error) {
    return failedParse(raw, `review output could not be validated: ${error.message}`)
  }
}
