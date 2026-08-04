import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawnDetached, terminate } from '../../scripts/lib/process.mjs'
import { OpencodeClient, parseSseChunk, HttpError } from '../../scripts/lib/server.mjs'

const bin = fileURLToPath(new URL('../fixture-bin/opencode', import.meta.url))
const loopbackAvailable = await new Promise((resolve) => {
  const server = createServer()
  server.once('error', () => resolve(false))
  server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
})

let child
let baseUrl

async function startFixture(fault = '') {
  const fixture = spawnDetached(
    bin,
    ['serve', '--port', '0', '--hostname', '127.0.0.1'],
    {
      env: { ...process.env, FAKE_OPENCODE_FAULT: fault },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no port')), 10000)
      const onData = (data) => {
        const match = String(data).match(/listening on http:\/\/[^:]+:(\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      }
      fixture.stdout.on('data', onData)
      fixture.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      fixture.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timer)
          reject(new Error(`fixture exited with ${code}`))
        }
      })
    })
    return { child: fixture, baseUrl: `http://127.0.0.1:${port}` }
  } catch (error) {
    await terminate(fixture.pid)
    fixture.stdout?.destroy()
    fixture.stderr?.destroy()
    throw error
  }
}

async function stopFixture(fixture) {
  await terminate(fixture.child.pid)
  fixture.child.stdout?.destroy()
  fixture.child.stderr?.destroy()
}

test('parseSseChunk splits complete frames and keeps the remainder', () => {
  const result = parseSseChunk('data: {"payload":{"type":"a"}}\n\ndata: {"payload":{"typ')
  assert.deepEqual(result.events, [{ payload: { type: 'a' } }])
  assert.equal(result.rest, 'data: {"payload":{"typ')
})

test('parseSseChunk ignores comments, empty frames, and malformed JSON', () => {
  const result = parseSseChunk(': keepalive\n\ndata: not-json\n\ndata: {"payload":{"type":"b"}}\n\n')
  assert.deepEqual(result.events, [{ payload: { type: 'b' } }])
})

function sseFrame(payload) {
  return `data: ${JSON.stringify({ payload })}\n\n`
}

function parseSseChunks(chunks) {
  let buffer = ''
  const events = []
  for (const chunk of chunks) {
    const parsed = parseSseChunk(buffer + chunk)
    buffer = parsed.rest
    events.push(...parsed.events)
  }
  assert.equal(buffer, '')
  return events
}

function splitString(value, index) {
  return [value.slice(0, index), value.slice(index)]
}

test('parseSseChunk returns identical events for arbitrary chunk boundaries', () => {
  const first = sseFrame({ type: 'alpha', properties: { text: 'one' } })
  const special = sseFrame({ type: 'text', properties: { text: 'contains\n\n} and more' } })
  const third = sseFrame({ type: 'omega', properties: { count: 3 } })
  const stream = first + special + third
  const expected = parseSseChunks([stream])

  const keyValueBoundary = stream.indexOf('"type":"alpha"') + '"type":'.length
  const stringBoundary = first.length + special.indexOf('contains') + 3
  const delimiterBoundary = stream.indexOf('\n\n') + 1
  const partialFrameBoundary = Math.floor(special.length / 2)
  assert.ok(keyValueBoundary > 0)
  assert.ok(special.includes('contains\\n\\n} and more'))
  assert.equal(stream[delimiterBoundary - 1], '\n')
  assert.equal(stream[delimiterBoundary], '\n')

  const chunkings = [
    splitString(stream, keyValueBoundary),
    splitString(stream, stringBoundary),
    splitString(stream, delimiterBoundary),
    Array.from(stream),
    [first + special, third],
    [first + special.slice(0, partialFrameBoundary), special.slice(partialFrameBoundary) + third],
  ]

  for (const chunks of chunkings) {
    assert.deepEqual(parseSseChunks(chunks), expected)
  }
})

test('events preserves UTF-8 characters split across reads', async () => {
  const payload = {
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses_test',
      messageID: 'msg_test',
      partID: 'prt_test',
      field: 'text',
      delta: 'before 🧪 after 中文',
    },
  }
  const encoded = new TextEncoder().encode(sseFrame(payload))
  const marker = new TextEncoder().encode('🧪')
  let markerOffset = -1
  for (let index = 0; index <= encoded.length - marker.length; index += 1) {
    if (marker.every((byte, offset) => encoded[index + offset] === byte)) {
      markerOffset = index
      break
    }
  }
  assert.ok(markerOffset >= 0)

  const chunks = [encoded.slice(0, markerOffset + 1), encoded.slice(markerOffset + 1)]
  let readIndex = 0
  const reader = {
    async read() {
      if (readIndex === chunks.length) return { done: true, value: undefined }
      return { done: false, value: chunks[readIndex++] }
    },
    async cancel() {},
  }
  const client = new OpencodeClient('http://fixture.test', {
    fetchImpl: async () => ({ ok: true, body: { getReader: () => reader } }),
  })
  const seen = []

  await client.events({ onEvent: (event) => seen.push(event) })

  assert.deepEqual(seen, [payload])
})

test('health is false for a dead endpoint', async () => {
  const client = new OpencodeClient('http://127.0.0.1:1')
  assert.equal(await client.health({ timeoutMs: 500 }), false)
})

test('events resolves without fetching when already aborted', async () => {
  let called = false
  const client = new OpencodeClient('http://127.0.0.1:1', {
    fetchImpl: async () => {
      called = true
      throw new Error('fetch should not be called')
    },
  })
  const controller = new AbortController()
  controller.abort()
  await client.events({ signal: controller.signal, onEvent: () => {} })
  assert.equal(called, false)
})

test('auth uses Basic credentials without exposing them in HttpError diagnostics', async () => {
  const username = 'fixture-user'
  const password = 'fixture-secret'
  let request
  const client = new OpencodeClient('http://fixture.test', {
    username,
    password,
    fetchImpl: async (_url, options) => {
      request = options
      return new Response('{}', { status: 200 })
    },
  })
  await client.doc()
  const encoded = Buffer.from(`${username}:${password}`).toString('base64')
  assert.equal(request.headers.authorization, `Basic ${encoded}`)

  const failing = new OpencodeClient('http://fixture.test', {
    username,
    password,
    fetchImpl: async () => new Response(`failure ${password} ${encoded}`, { status: 401 }),
  })
  await assert.rejects(() => failing.doc(), (error) => (
    error instanceof HttpError
      && !error.message.includes(password)
      && !error.message.includes(encoded)
      && !error.body.includes(password)
      && !error.body.includes(encoded)
  ))
})

describe('live fixture server', { skip: !loopbackAvailable }, () => {
  before(async () => {
    const fixture = await startFixture()
    child = fixture.child
    baseUrl = fixture.baseUrl
  })

  after(async () => {
    if (child) {
      await terminate(child.pid)
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
  })

  test('doc and health succeed against a live fixture server', async () => {
    const client = new OpencodeClient(baseUrl)
    assert.ok((await client.doc()).paths)
    assert.equal(await client.health(), true)
  })

  test('createSession returns a session id', async () => {
    const client = new OpencodeClient(baseUrl)
    const session = await client.createSession({ title: 'test' })
    assert.match(session.id, /^ses_/)
  })

  test('promptAsync drives events to session.idle', async () => {
    const client = new OpencodeClient(baseUrl)
    const session = await client.createSession({ title: 'test' })
    const seen = []
    const controller = new AbortController()
    let connected
    const connectedPromise = new Promise((resolve) => { connected = resolve })
    const streaming = client.events({
      signal: controller.signal,
      onEvent: (payload) => {
        seen.push(payload.type)
        if (payload.type === 'server.connected') connected()
        if (payload.type === 'session.idle') controller.abort()
      },
    })
    await connectedPromise
    await client.promptAsync(session.id, { parts: [{ type: 'text', text: 'review this' }] })
    await streaming
    assert.ok(seen.includes('message.part.updated'))
    assert.ok(seen.includes('session.idle'))
  })

  test('events resolves and cancels the stream when aborted mid-stream', async () => {
    const fixture = await startFixture()
    try {
      const client = new OpencodeClient(fixture.baseUrl)
      const controller = new AbortController()
      let connected
      const connectedPromise = new Promise((resolve) => { connected = resolve })
      const streaming = client.events({
        signal: controller.signal,
        onEvent: (payload) => {
          if (payload.type === 'server.connected') connected()
        },
      })
      await connectedPromise
      controller.abort()
      await streaming
    } finally {
      await stopFixture(fixture)
    }
  })

  test('malformed-json fixture events continue to the terminal event', async () => {
    const fixture = await startFixture('malformed-json')
    try {
      const client = new OpencodeClient(fixture.baseUrl)
      const session = await client.createSession({})
      const seen = []
      const controller = new AbortController()
      let connected
      const connectedPromise = new Promise((resolve) => { connected = resolve })
      const streaming = client.events({
        signal: controller.signal,
        onEvent: (payload) => {
          seen.push(payload)
          if (payload.type === 'server.connected') connected()
          if (payload.type === 'session.idle') controller.abort()
        },
      })
      await connectedPromise
      await client.promptAsync(session.id, { parts: [{ type: 'text', text: 'review this' }] })
      await streaming
      assert.equal(seen.filter((payload) => payload.type === 'message.part.delta').length, 5)
      assert.equal(seen.at(-1).type, 'session.idle')
    } finally {
      await stopFixture(fixture)
    }
  })

  test('sse disconnect rejects as a handled stream error', async () => {
    const fixture = await startFixture('sse-disconnect')
    try {
      const client = new OpencodeClient(fixture.baseUrl)
      const session = await client.createSession({})
      const controller = new AbortController()
      let connected
      const connectedPromise = new Promise((resolve) => { connected = resolve })
      const streaming = client.events({
        signal: controller.signal,
        onEvent: (payload) => {
          if (payload.type === 'server.connected') connected()
        },
      })
      await connectedPromise
      await client.promptAsync(session.id, { parts: [{ type: 'text', text: 'review this' }] })
      await assert.rejects(streaming)
    } finally {
      await stopFixture(fixture)
    }
  })

  test('a 404 raises HttpError with the status', async () => {
    const client = new OpencodeClient(baseUrl)
    await assert.rejects(() => client.request('GET', '/nope'), (error) => (
      error instanceof HttpError && error.status === 404
    ))
  })

  test('abort resolves', async () => {
    const client = new OpencodeClient(baseUrl)
    const session = await client.createSession({})
    await client.abort(session.id)
  })
})
