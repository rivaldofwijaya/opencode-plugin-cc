#!/usr/bin/env node
// Spawns `opencode serve` and prints one JSON line: {"port":N,"pid":N}.
// Used by broker-lifecycle.ensureBroker. Not a user-facing entrypoint.
import { resolveBinary, buildServeArgs } from './lib/opencode.mjs'
import { isAlive, spawnDetached, terminate } from './lib/process.mjs'
import { writeFile } from 'node:fs/promises'

const password = process.env.OPENCODE_SERVER_PASSWORD || ''
let child
let settled = false
let timer
let stderrBuf = ''

const redact = (text) => password ? String(text).split(password).join('[REDACTED]') : String(text)

async function fail(message) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  if (child?.pid && isAlive(child.pid)) {
    await terminate(child.pid, { graceMs: 3000 })
  }
  process.stderr.write(redact(message))
  process.exitCode = 1
}

async function main() {
  let bin
  try {
    ({ path: bin } = await resolveBinary({ env: process.env }))
    child = spawnDetached(bin, buildServeArgs({ port: 0, hostname: '127.0.0.1' }), {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    await fail(`broker: could not start opencode serve: ${error.message}\n`)
    return
  }

  timer = setTimeout(() => {
    void fail('broker: opencode serve did not report a port within 20s\n')
  }, 20_000)

  child.stderr.on('data', (data) => {
    stderrBuf += data.toString()
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
  })

  child.once('error', (error) => {
    void fail(`broker: opencode serve process error: ${error.message}\n${stderrBuf}`)
  })

  child.once('exit', (code, signal) => {
    if (settled) return
    void fail(`broker: opencode serve exited with ${code ?? 'signal ' + signal}\n${stderrBuf}`)
  })

  // Test-only observability for proving the startup-failure reap path. It is
  // intentionally opt-in and records only the child PID, never credentials.
  if (process.env.OPENCODE_BROKER_CHILD_PID_FILE) {
    try {
      await writeFile(process.env.OPENCODE_BROKER_CHILD_PID_FILE, `${child.pid}\n`)
    } catch (error) {
      await fail(`broker: could not record child PID: ${error.message}\n`)
      return
    }
  }

  let stdoutBuf = ''
  child.stdout.on('data', (data) => {
    if (settled) return
    stdoutBuf += data.toString()
    const match = stdoutBuf.match(/listening on http:\/\/[^:]+:(\d+)/)
    if (!match) return
    settled = true
    clearTimeout(timer)
    process.stdout.write(JSON.stringify({ port: Number(match[1]), pid: child.pid }) + '\n')
    // The server is deliberately detached. The lifecycle owner records its
    // PID and is responsible for terminating it after the final release.
    child.unref()
    process.exit(0)
  })

  process.once('SIGTERM', () => { void fail('broker: interrupted\n') })
  process.once('SIGINT', () => { void fail('broker: interrupted\n') })
}

await main()
