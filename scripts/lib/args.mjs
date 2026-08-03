export function parseArgs(argv, { includeFlagTokens = false } = {}) {
  const flags = {}
  const positional = []
  const flagTokens = []
  let verb = null
  let i = 0
  if (argv[i] && !argv[i].startsWith('-')) verb = argv[i++]
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        const name = body.slice(0, eq)
        const value = body.slice(eq + 1)
        flags[name] = value
        flagTokens.push({ raw: a, name, negated: false, value })
        continue
      }
      if (body.startsWith('no-')) {
        const name = body.slice(3)
        flags[name] = false
        flagTokens.push({ raw: a, name, negated: true, value: false })
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next
        flagTokens.push({ raw: a, name: body, negated: false, value: next })
        i++
      } else {
        flags[body] = true
        flagTokens.push({ raw: a, name: body, negated: false, value: true })
      }
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        flagTokens.push({ raw: a, name: key, negated: false, value: next })
        i++
      } else {
        flags[key] = true
        flagTokens.push({ raw: a, name: key, negated: false, value: true })
      }
      continue
    }
    positional.push(a)
  }
  const result = { verb, flags, positional }
  if (includeFlagTokens) result.flagTokens = flagTokens
  return result
}
