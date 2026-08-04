import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, terminate, isAlive } from '../../scripts/lib/process.mjs'
import { spawnTracked } from '../helpers/process-cleanup.mjs'

const bin = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))

const loopbackAvailable = await new Promise((resolve) => {
  const server = createServer()
  server.once('error', () => resolve(false))
  server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
})

async function waitForPort(child) {
  return (await waitForServer(child)).port
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`fixture never printed a port: ${output}`)), 10000)
    const onData = (data) => {
      output += String(data)
      const match = output.match(/listening on http:\/\/([^:]+):(\d+)/)
      if (match) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve({ hostname: match[1], port: Number(match[2]) })
      }
    }
    child.stdout.on('data', onData)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`fixture exited before listening (code ${code}): ${output}`))
    })
  })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return port
}

async function collectEvents(response, stop) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  const deadline = Date.now() + 10000

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      let timer
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out reading SSE')), remaining)
        }),
      ]).finally(() => clearTimeout(timer))
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').find((line) => line.startsWith('data: '))
        if (!data) continue
        const event = JSON.parse(data.slice('data: '.length))
        events.push(event)
        if (stop(event)) return events
      }
    }
    throw new Error('timed out waiting for the requested SSE event')
  } finally {
    await reader.cancel()
  }
}

test('fixture reports a version', async () => {
  const r = await run(bin, ['--version'])
  assert.equal(r.stdout.trim(), '1.18.11')
})

test('fixture honours the old-version fault', async () => {
  const r = await run(bin, ['--version'], { env: { ...process.env, FAKE_OPENCODE_FAULT: 'old-version' } })
  assert.equal(r.stdout.trim(), '1.17.0')
})

test('fixture lists models', async () => {
  const r = await run(bin, ['models'], { env: { ...process.env, FAKE_OPENCODE_MODELS: 'a/b,c/d' } })
  assert.deepEqual(r.stdout.trim().split('\n'), ['a/b', 'c/d'])
})

test('fixture auth list reads providers from auth.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-plugin-cc-fixture-'))
  const dataHome = join(root, 'data')
  const authPath = join(dataHome, 'opencode', 'auth.json')
  await mkdir(join(dataHome, 'opencode'), { recursive: true })
  await writeFile(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'a' }, openai: { type: 'api', key: 'b' } }))

  try {
    const r = await run(bin, ['auth', 'list'], {
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: dataHome,
        FAKE_OPENCODE_PROVIDERS: 'wrong-provider',
      },
    })
    assert.match(r.stdout, /anthropic/)
    assert.match(r.stdout, /openai/)
    assert.doesNotMatch(r.stdout, /wrong-provider/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fixture can use provider env as an override when auth.json is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-plugin-cc-fixture-'))
  try {
    const r = await run(bin, ['auth', 'list'], {
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: join(root, 'data'),
        FAKE_OPENCODE_PROVIDERS: 'openrouter,google',
      },
    })
    assert.match(r.stdout, /openrouter/)
    assert.match(r.stdout, /google/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fixture gives identical results for space and equals-valued serve flags', { skip: !loopbackAvailable }, async (t) => {
  const port = await availablePort()
  const results = []
  const invocations = [
    ['serve', '--port', String(port), '--hostname', '0.0.0.0'],
    ['serve', `--port=${port}`, '--hostname=0.0.0.0'],
  ]

  for (const args of invocations) {
    const child = spawnTracked(t, bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    try {
      const listening = await waitForServer(child)
      assert.deepEqual(listening, { hostname: '0.0.0.0', port })
      const doc = await fetch(`http://127.0.0.1:${port}/doc`)
      results.push({ status: doc.status, body: await doc.json() })
    } finally {
      await terminate(child.pid)
      assert.equal(isAlive(child.pid), false)
    }
  }

  assert.deepEqual(results[1], results[0])
})

test('fixture does not silently ignore an equals-form port value', async () => {
  const r = await run(bin, ['serve', '--port=65536', '--hostname=0.0.0.0'], { timeoutMs: 1000 })
  assert.equal(r.timedOut, false)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /ERR_SOCKET_BAD_PORT/)
})

test('fixture serve answers /doc and replays typed SSE events', { skip: !loopbackAvailable }, async (t) => {
  const child = spawnTracked(t, bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    const port = await waitForPort(child)
    const base = `http://127.0.0.1:${port}`
    const doc = await fetch(`${base}/doc`)
    assert.equal(doc.status, 200)
    assert.deepEqual((await doc.json()).openapi, '3.0.0')

    const eventResponse = await fetch(`${base}/global/event`)
    assert.equal(eventResponse.status, 200)
    const sessionResponse = await fetch(`${base}/session`, { method: 'POST' })
    assert.equal(sessionResponse.status, 200)
    const session = await sessionResponse.json()
    const promptResponse = await fetch(`${base}/session/${session.id}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'review' }] }),
    })
    assert.equal(promptResponse.status, 200)
    assert.equal((await promptResponse.json()).messageID, 'msg_fake_1')

    const events = await collectEvents(
      eventResponse,
      (event) => event.payload.type === 'session.idle',
    )
    const payloads = events.map((event) => event.payload)
    const types = payloads.map((event) => event.type)
    const userMessage = payloads.find(
      (event) => event.type === 'message.updated' && event.properties.info.role === 'user',
    )
    const userPart = payloads.find(
      (event) => event.type === 'message.part.updated' && event.properties.part.messageID === 'msg_fake_user',
    )
    const assistantMessage = payloads.find(
      (event) => event.type === 'message.updated' && event.properties.info.role === 'assistant',
    )
    const reasoningDelta = payloads.find(
      (event) => event.type === 'message.part.delta' && event.properties.partID === 'prt_fake_reasoning',
    )
    const reasoningPart = payloads.find(
      (event) => event.type === 'message.part.updated' && event.properties.part.type === 'reasoning',
    )
    const textParts = payloads.filter(
      (event) => event.type === 'message.part.updated' && event.properties.part.id === 'prt_fake_text',
    )
    const step = payloads.find(
      (event) => event.type === 'message.part.updated' && event.properties.part.type === 'step-finish',
    )
    const finalMessage = payloads.at(-2)
    assert.equal(userMessage.properties.info.id, 'msg_fake_user')
    assert.equal(userPart.properties.part.type, 'text')
    assert.equal(assistantMessage.properties.info.id, 'msg_fake_1')
    assert.equal(reasoningDelta.properties.field, 'text')
    assert.equal(reasoningDelta.properties.partID, 'prt_fake_reasoning')
    assert.ok(payloads.indexOf(reasoningDelta) < payloads.indexOf(reasoningPart))
    assert.equal(reasoningPart.properties.part.type, 'reasoning')
    assert.deepEqual(textParts.map((event) => event.properties.part.text), ['', '{"findings":[{"file":"src/a.js","line":10,"severity":"high","confidence":"high","body":"Null deref."}]}'])
    assert.equal(step.properties.part.tokens.output, 8)
    assert.equal(finalMessage.type, 'message.updated')
    assert.equal(payloads.at(-1).type, 'session.idle')
  } finally {
    await terminate(child.pid)
    assert.equal(isAlive(child.pid), false)
  }
})

test('fixture reports nonzero and port-bound faults', async () => {
  const failed = await run(bin, ['anything'], { env: { ...process.env, FAKE_OPENCODE_FAULT: 'nonzero-exit' } })
  assert.equal(failed.code, 3)
  assert.match(failed.stderr, /fake opencode failed/)

  const bound = await run(bin, ['serve', '--port', '0'], { env: { ...process.env, FAKE_OPENCODE_FAULT: 'port-bound' } })
  assert.equal(bound.code, 1)
  assert.match(bound.stderr, /EADDRINUSE/)
})

test('fixture malformed-json fault changes assistant text deltas', { skip: !loopbackAvailable }, async (t) => {
  const child = spawnTracked(t, bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    env: { ...process.env, FAKE_OPENCODE_FAULT: 'malformed-json' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    const port = await waitForPort(child)
    const base = `http://127.0.0.1:${port}`
    const eventResponse = await fetch(`${base}/global/event`)
    const session = await (await fetch(`${base}/session`, { method: 'POST' })).json()
    await fetch(`${base}/session/${session.id}/prompt_async`, { method: 'POST' })
    const events = await collectEvents(eventResponse, (event) => event.payload.type === 'session.idle')
    const deltas = events
      .map((event) => event.payload)
      .filter((event) => event.type === 'message.part.delta')
      .map((event) => event.properties.delta)
    assert.ok(deltas.includes('not json at all'))
  } finally {
    await terminate(child.pid)
    assert.equal(isAlive(child.pid), false)
  }
})
