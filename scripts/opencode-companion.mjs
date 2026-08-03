#!/usr/bin/env node
import { parseArgs } from './lib/args.mjs'
import { runDoctor, requireReady, CompanionError } from './lib/doctor.mjs'
import { renderDoctor } from './lib/render.mjs'
import { setKey } from './lib/credentials.mjs'
import { setModel } from './lib/config.mjs'
import { readGate, writeGate } from './lib/gate.mjs'
import { resolveBinary } from './lib/opencode.mjs'
import { run } from './lib/process.mjs'
import { reapOrphans } from './lib/broker-lifecycle.mjs'
import { pruneStale } from './lib/tracked-jobs.mjs'

// Exit-code contract: 0 is success, 1 is a reported gap (doctor's approved
// R12.4 JSON-on-stdout exemption), 2 is an invalid invocation, and 3 is an
// unexpected crash. Keeping these distinct prevents stream choice from being
// the only way to tell a gap from a crash.
export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  GAP: 1,
  INVALID_INVOCATION: 2,
  CRASH: 3,
})

// These later handlers intentionally bypass the doctor preflight while they
// repair or inspect setup state: setup, set-key, set-model, gate, repair,
// review-size, task-resume-candidate, status, result, and cancel.
// Other handlers must call requireReady before doing work that needs readiness.
const handlers = {
  doctor: async ({ flags, env, cwd }) => {
    const report = await runDoctor({ env, cwd, checkServer: flags.server !== false })
    // Approved R12.4: doctor --json reports a detected gap on stdout only;
    // unexpected crashes still use the main error path and stderr.
    const stdout = flags.json ? JSON.stringify(report, null, 2) : renderDoctor(report)
    return { stdout, exitCode: report.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.GAP }
  },

  'set-key': async ({ flags, env, cwd }) => {
    if (!flags.provider || flags.provider === true) throw new CompanionError('set-key requires --provider <name>')
    if (!flags.key || flags.key === true) throw new CompanionError('set-key requires --key <API_KEY>')
    let res
    try {
      res = await setKey({ provider: flags.provider, key: String(flags.key), env })
    } catch (error) {
      throw new CompanionError(error.message)
    }
    const lines = [`Stored a key for ${res.provider} (${res.redacted}) in ${res.path}.`]
    if (res.backup) lines.push(`Backed up the previous file to ${res.backup}.`)
    const report = await runDoctor({ env, cwd, checkServer: false })
    lines.push('', renderDoctor(report))
    return { stdout: lines.join('\n'), exitCode: EXIT_CODES.SUCCESS }
  },

  'set-model': async ({ flags, env, cwd }) => {
    if (!flags.model || flags.model === true) throw new CompanionError('set-model requires --model <provider/model>')
    if (flags.scope !== undefined && flags.scope !== 'global' && flags.scope !== 'project') {
      throw new CompanionError('invalid invocation: set-model --scope must be global or project', EXIT_CODES.INVALID_INVOCATION)
    }
    const scope = flags.scope ?? 'global'
    let res
    try {
      res = await setModel({ model: String(flags.model), scope, env, cwd })
    } catch (error) {
      throw new CompanionError(error.message)
    }
    const lines = [`Set the default model to ${flags.model} in ${res.path} (${scope} scope).`]
    if (res.backup) lines.push(`Backed up the previous file to ${res.backup}.`)
    lines.push(`Comments were dropped: ${res.commentsDropped ? 'yes' : 'no'}.`)
    const report = await runDoctor({ env, cwd, checkServer: false })
    lines.push('', renderDoctor(report))
    return { stdout: lines.join('\n'), exitCode: report.model.ok ? EXIT_CODES.SUCCESS : EXIT_CODES.GAP }
  },

  models: async ({ flags, env }) => {
    const bin = await resolveBinary({ env })
    const r = await run(bin.path, ['models'], { env, timeoutMs: 60000 })
    if (r.code !== 0) throw new CompanionError(`opencode models failed:\n${r.stderr.trim()}`)
    let lines = r.stdout.split('\n').map(line => line.trim()).filter(Boolean)
    if (flags.provider && flags.provider !== true) {
      lines = lines.filter(line => line.startsWith(`${flags.provider}/`))
    }
    return { stdout: lines.join('\n'), exitCode: EXIT_CODES.SUCCESS }
  },

  gate: async ({ flags, env }) => {
    const requested = [flags.on, flags.off, flags.status].filter(Boolean).length
    if (requested > 1) {
      throw new CompanionError('invalid invocation: gate accepts only one of --on, --off, or --status', EXIT_CODES.INVALID_INVOCATION)
    }
    if (flags.on) await writeGate(true, env)
    else if (flags.off) await writeGate(false, env)
    const on = await readGate(env)
    return {
      stdout: flags.status ? (on ? 'on' : 'off') : `The Stop review gate is ${on ? 'on' : 'off'}.`,
      exitCode: EXIT_CODES.SUCCESS,
    }
  },

  repair: async ({ env }) => {
    const broker = await reapOrphans(env)
    const jobs = await pruneStale(env)
    const lines = [
      broker.cleared ? 'Cleared a stale broker portfile.' : 'The broker record was already clean.',
      jobs.stale.length ? `Marked ${jobs.stale.length} orphaned job record(s) stale: ${jobs.stale.join(', ')}` : 'No orphaned job records.',
      jobs.removed.length ? `Removed ${jobs.removed.length} expired job record(s).` : 'No expired job records.',
    ]
    return { stdout: lines.join('\n'), exitCode: EXIT_CODES.SUCCESS }
  },
}

export const VERBS = Object.keys(handlers)

// Every dispatched verb owns an explicit flag and positional-argument
// contract. A future handler must add its declaration here before it can be
// reached by the dispatcher.
export const COMMAND_SPECS = Object.freeze({
  doctor: {
    flags: {
      help: { type: 'boolean' },
      json: { type: 'boolean' },
      server: { type: 'boolean', negatable: true },
    },
    maxPositionals: 0,
  },
  'set-key': {
    flags: {
      help: { type: 'boolean' },
      provider: { type: 'value' },
      key: { type: 'value' },
    },
    maxPositionals: 0,
  },
  'set-model': {
    flags: {
      help: { type: 'boolean' },
      model: { type: 'value' },
      scope: { type: 'value' },
    },
    maxPositionals: 0,
  },
  models: {
    flags: {
      help: { type: 'boolean' },
      provider: { type: 'value' },
    },
    maxPositionals: 0,
  },
  gate: {
    flags: {
      help: { type: 'boolean' },
      on: { type: 'boolean' },
      off: { type: 'boolean' },
      status: { type: 'boolean' },
    },
    maxPositionals: 0,
  },
  repair: {
    flags: {
      help: { type: 'boolean' },
    },
    maxPositionals: 0,
  },
})

function usage() {
  return [
    'opencode-companion.mjs <verb> [flags]',
    '',
    'Verbs:',
    ...VERBS.map(v => `  ${v}`),
    '',
    'Flags are verb-specific; see the /opencode:* command definitions.',
  ].join('\n')
}

export function ccSessionId(env = process.env) {
  return env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || 'default'
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= right.length; j++) {
      const above = row[j]
      row[j] = left[i - 1] === right[j - 1]
        ? diagonal
        : Math.min(diagonal, above, row[j - 1]) + 1
      diagonal = above
    }
  }
  return row[right.length]
}

function allowedFlagLabels(spec) {
  return Object.entries(spec.flags).flatMap(([name, definition]) => [
    `--${name}`,
    ...(definition.negatable ? [`--no-${name}`] : []),
  ])
}

function closestFlag(raw, spec) {
  const target = raw.replace(/^-+/, '').replace(/^no-/, '')
  const candidates = allowedFlagLabels(spec)
  let closest
  let distance = Infinity
  for (const candidate of candidates) {
    const candidateName = candidate.slice(2).replace(/^no-/, '')
    const nextDistance = editDistance(target, candidateName)
    if (nextDistance < distance) {
      closest = candidate
      distance = nextDistance
    }
  }
  return distance <= Math.max(1, Math.floor(target.length / 3)) ? closest : null
}

function validateInvocation({ verb, flags, positional, flagTokens, commandSpec }) {
  const spec = commandSpec ?? COMMAND_SPECS[verb]
  if (!spec) throw new Error(`internal error: no command specification for ${verb}`)

  for (const token of flagTokens) {
    const definition = spec.flags[token.name]
    if (!definition || (token.negated && !definition.negatable)) {
      const suggestion = closestFlag(token.raw, spec)
      const hint = suggestion ? `; did you mean ${suggestion}?` : ''
      throw new CompanionError(
        `invalid invocation: unknown flag ${token.raw} for ${verb}${hint}`,
        EXIT_CODES.INVALID_INVOCATION,
      )
    }
    if (token.missingValue) {
      throw new CompanionError(
        `invalid invocation: flag ${token.raw} for ${verb} requires a value`,
        EXIT_CODES.INVALID_INVOCATION,
      )
    }
    if (definition.type === 'boolean' && typeof token.value === 'string') {
      if (token.value !== 'true' && token.value !== 'false') {
        throw new CompanionError(
          `invalid invocation: flag ${token.raw} for ${verb} does not take a value`,
          EXIT_CODES.INVALID_INVOCATION,
        )
      }
      flags[token.name] = token.value === 'true'
    }
  }

  if (positional.length > spec.maxPositionals) {
    const argument = positional[spec.maxPositionals]
    throw new CompanionError(
      `invalid invocation: unexpected positional argument ${JSON.stringify(argument)} for ${verb}`,
      EXIT_CODES.INVALID_INVOCATION,
    )
  }
}

function checkedHandlerResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
    || (result.stdout !== undefined && typeof result.stdout !== 'string')) {
    throw new Error('internal error: handler returned a missing or malformed result')
  }
  return result
}

async function main(argv, env = process.env, cwd = process.cwd()) {
  const { verb, flags, positional, flagTokens } = parseArgs(argv, {
    includeFlagTokens: true,
    commandSpecs: COMMAND_SPECS,
  })
  if (!verb && (argv.length === 0 || (argv.length === 1 && argv[0] === '--help'))) {
    process.stdout.write(usage() + '\n')
    return EXIT_CODES.SUCCESS
  }

  if (!verb) {
    const detail = flagTokens[0]?.raw
      ? `expected a verb before ${flagTokens[0].raw}`
      : 'expected a verb'
    process.stderr.write(`invalid invocation: ${detail}\n`)
    return EXIT_CODES.INVALID_INVOCATION
  }

  const handler = handlers[verb]
  if (!handler) {
    process.stderr.write(`unknown verb: ${verb}\n\n${usage()}\n`)
    return EXIT_CODES.INVALID_INVOCATION
  }

  try {
    validateInvocation({ verb, flags, positional, flagTokens })
    if (flags.help) {
      process.stdout.write(usage() + '\n')
      return EXIT_CODES.SUCCESS
    }

    const result = checkedHandlerResult(
      await handler({ flags, positional, env, cwd, ccSessionId: ccSessionId(env) }),
    )
    if (result?.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n')
    return result.exitCode
  } catch (error) {
    process.stderr.write((error instanceof CompanionError
      ? error.message
      : `opencode-plugin-cc: ${error.stack || error.message}`) + '\n')
    return error instanceof CompanionError && Number.isInteger(error.exitCode)
      ? error.exitCode
      : EXIT_CODES.CRASH
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2))
}

export { main, handlers, usage, validateInvocation }
