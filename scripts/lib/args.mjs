export function parseArgs(argv) {
  const flags = {}
  const positional = []
  let verb = null
  let i = 0
  if (argv[i] && !argv[i].startsWith('-')) verb = argv[i++]
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue }
      if (body.startsWith('no-')) { flags[body.slice(3)] = false; continue }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) { flags[body] = next; i++ }
      else flags[body] = true
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++ }
      else flags[key] = true
      continue
    }
    positional.push(a)
  }
  return { verb, flags, positional }
}
