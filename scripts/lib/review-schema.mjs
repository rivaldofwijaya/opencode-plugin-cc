// Production always loads the packaged schema below. The exported loadSchema(path)
// and optional validateReview contract argument are explicit in-process test seams;
// URL query parameters and environment variables cannot replace the production contract.
import { fileURLToPath } from 'node:url'

import { readJsonc } from './fs.mjs'

const defaultSchemaPath = fileURLToPath(new URL('../../schemas/review-output.schema.json', import.meta.url))

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0
    || value.some(item => typeof item !== 'string' || item === '')) {
    throw new Error(`${label} must be a non-empty array of strings`)
  }
  return value
}

function schemaContract(schema) {
  const root = requireObject(schema, 'root')
  const reviewProperties = requireObject(root.properties, 'root.properties')
  const reviewRequired = requireStringArray(root.required, 'root.required')
  for (const [key, definition] of Object.entries(reviewProperties)) {
    requireObject(definition, `root.properties.${key}`)
  }
  const findingsSchema = requireObject(reviewProperties.findings, 'root.properties.findings')
  const findingSchema = requireObject(findingsSchema.items, 'root.properties.findings.items')
  const findingProperties = requireObject(findingSchema.properties, 'root.properties.findings.items.properties')
  for (const [key, definition] of Object.entries(findingProperties)) {
    requireObject(definition, `root.properties.findings.items.properties.${key}`)
  }
  const findingRequired = requireStringArray(
    findingSchema.required,
    'root.properties.findings.items.required',
  )
  const severityValues = requireStringArray(
    findingProperties.severity?.enum,
    'root.properties.findings.items.properties.severity.enum',
  )
  const confidenceValues = requireStringArray(
    findingProperties.confidence?.enum,
    'root.properties.findings.items.properties.confidence.enum',
  )

  for (const key of reviewRequired) {
    if (!Object.hasOwn(reviewProperties, key)) {
      throw new Error(`root.required references missing property "${key}"`)
    }
  }
  for (const key of findingRequired) {
    if (!Object.hasOwn(findingProperties, key)) {
      throw new Error(`root.properties.findings.items.required references missing property "${key}"`)
    }
  }
  if (findingsSchema.type !== 'array' || findingSchema.type !== 'object') {
    throw new Error('findings must be an array of objects')
  }

  return {
    reviewProperties,
    reviewKeys: new Set(Object.keys(reviewProperties)),
    reviewRequired,
    findingProperties,
    findingKeys: new Set(Object.keys(findingProperties)),
    findingRequired,
    severityValues,
    confidenceValues,
  }
}

export async function loadSchema(path = defaultSchemaPath) {
  let schema
  try {
    schema = await readJsonc(path)
  } catch (error) {
    throw new Error(`could not load review schema "${path}": ${error.message}`, { cause: error })
  }
  if (schema === null) throw new Error(`could not load review schema "${path}": file not found`)

  try {
    return schemaContract(schema)
  } catch (error) {
    throw new Error(`malformed review schema "${path}": ${error.message}`, { cause: error })
  }
}

const CONTRACT = await loadSchema()

export const SEVERITIES = CONTRACT.severityValues
export const CONFIDENCES = CONTRACT.confidenceValues

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

function matchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isObject(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function schemaValueError(value, definition, path) {
  const types = Array.isArray(definition.type) ? definition.type : [definition.type]
  if (definition.enum && !definition.enum.includes(value)) {
    return `${path} must be one of ${definition.enum.join(', ')}`
  }
  if (definition.type && !types.some(type => matchesType(value, type))) {
    if (types.includes('string') && definition.minLength > 0) {
      return `${path} must be a non-empty string`
    }
    if (types.includes('integer') && types.includes('null')) {
      return `${path} must be a positive integer or null`
    }
    return `${path} has an invalid type`
  }
  if (typeof value === 'string' && definition.minLength !== undefined
    && value.length < definition.minLength) {
    return `${path} must be a non-empty string`
  }
  if (typeof value === 'number' && definition.minimum !== undefined
    && value < definition.minimum) {
    if (types.includes('integer') && types.includes('null')) {
      return `${path} must be a positive integer or null`
    }
    return `${path} must be at least ${definition.minimum}`
  }
  return null
}

export function validateReview(obj, contract = CONTRACT) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'review output must be a JSON object' }
  }

  const unknownReviewKey = unknownProperty(obj, contract.reviewKeys, 'review output')
  if (unknownReviewKey) return { ok: false, error: unknownReviewKey }
  for (const key of contract.reviewRequired) {
    if (!Object.hasOwn(obj, key)) {
      return {
        ok: false,
        error: key === 'findings'
          ? 'review output requires a "findings" array'
          : `review output requires a "${key}" field`,
      }
    }
  }
  for (const [key, definition] of Object.entries(contract.reviewProperties)) {
    if (!Object.hasOwn(obj, key) || key === 'findings') continue
    const error = schemaValueError(obj[key], definition, `"${key}"`)
    if (error) return { ok: false, error }
  }
  if (!Array.isArray(obj.findings)) {
    return { ok: false, error: 'review output requires a "findings" array' }
  }

  const findings = []
  for (const [i, finding] of obj.findings.entries()) {
    const at = `findings[${i}]`
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
      return { ok: false, error: `${at} must be an object` }
    }

    const unknownFindingKey = unknownProperty(finding, contract.findingKeys, at)
    if (unknownFindingKey) return { ok: false, error: unknownFindingKey }
    for (const key of contract.findingRequired) {
      if (!Object.hasOwn(finding, key)) {
        return { ok: false, error: `${at}.${key} is required` }
      }
    }
    for (const [key, definition] of Object.entries(contract.findingProperties)) {
      if (!Object.hasOwn(finding, key)) continue
      const error = schemaValueError(finding[key], definition, `${at}.${key}`)
      if (error) return { ok: false, error }
    }

    findings.push({
      ...finding,
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

function failedParse(raw, error, empty = false) {
  return { ok: false, findings: [], summary: null, raw, error, empty }
}

export function parseReviewOutput(text) {
  let raw
  try {
    raw = typeof text === 'string' ? text : String(text ?? '')
  } catch (error) {
    return failedParse('', `could not read model output: ${error.message}`)
  }

  if (!raw.trim()) return failedParse(raw, 'the model returned no output', true)

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
      empty: false,
    }
  } catch (error) {
    return failedParse(raw, `review output could not be validated: ${error.message}`)
  }
}
