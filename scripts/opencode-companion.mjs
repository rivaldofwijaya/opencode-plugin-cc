#!/usr/bin/env node
import { parseArgs } from './lib/args.mjs'
import { runDoctor, requireReady, CompanionError } from './lib/doctor.mjs'
import { renderDoctor } from './lib/render.mjs'

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
    return { stdout, exitCode: report.ok ? 0 : 1 }
  },
}

export const VERBS = Object.keys(handlers)

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

async function main(argv, env = process.env, cwd = process.cwd()) {
  const { verb, flags, positional } = parseArgs(argv)
  if (!verb || flags.help) {
    process.stdout.write(usage() + '\n')
    return 0
  }

  const handler = handlers[verb]
  if (!handler) {
    process.stderr.write(`unknown verb: ${verb}\n\n${usage()}\n`)
    return 2
  }

  try {
    const result = await handler({ flags, positional, env, cwd, ccSessionId: ccSessionId(env) })
    if (result?.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n')
    return result?.exitCode ?? 0
  } catch (error) {
    process.stderr.write((error instanceof CompanionError
      ? error.message
      : `opencode-plugin-cc: ${error.stack || error.message}`) + '\n')
    return error.exitCode ?? 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2))
}

export { main, handlers, usage }
