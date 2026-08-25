#!/usr/bin/env node
import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const fault = process.env.FAKE_OPENCODE_FAULT || ''
const version = process.env.FAKE_OPENCODE_VERSION || '1.18.11'
const USER_MESSAGE_ID = 'msg_fake_user'
const ASSISTANT_MESSAGE_ID = 'msg_fake_1'
const USER_PART_ID = 'prt_fake_user'
const REASONING_PART_ID = 'prt_fake_reasoning'
const TEXT_PART_ID = 'prt_fake_text'
const STEP_FINISH_PART_ID = 'prt_fake_step_finish'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DEFAULT_SCRIPT = [
  {
    type: 'message.updated',
    properties: { info: { id: USER_MESSAGE_ID, role: 'user' } },
  },
  {
    type: 'message.part.updated',
    properties: {
      part: {
        id: USER_PART_ID,
        messageID: USER_MESSAGE_ID,
        type: 'text',
        text: 'review',
      },
    },
  },
  {
    type: 'message.updated',
    properties: {
      info: {
        id: ASSISTANT_MESSAGE_ID,
        role: 'assistant',
        tokens: { input: 0, output: 0 },
      },
    },
  },
  {
    type: 'message.part.delta',
    properties: {
      messageID: ASSISTANT_MESSAGE_ID,
      partID: REASONING_PART_ID,
      field: 'text',
      delta: 'checking the changed file',
    },
  },
  {
    type: 'message.part.delta',
    properties: {
      messageID: ASSISTANT_MESSAGE_ID,
      partID: REASONING_PART_ID,
      field: 'text',
      delta: ' before answering',
    },
  },
  {
    type: 'message.part.updated',
    properties: {
      part: {
        id: REASONING_PART_ID,
        messageID: ASSISTANT_MESSAGE_ID,
        type: 'reasoning',
        text: 'checking the changed file before answering',
      },
    },
  },
  {
    type: 'message.part.updated',
    properties: {
      part: {
        id: TEXT_PART_ID,
        messageID: ASSISTANT_MESSAGE_ID,
        type: 'text',
        text: '',
      },
    },
  },
  {
    type: 'message.part.delta',
    properties: {
      messageID: ASSISTANT_MESSAGE_ID,
      partID: TEXT_PART_ID,
      field: 'text',
      delta: '{"findings":[',
    },
  },
  {
    type: 'message.part.delta',
    properties: {
      messageID: ASSISTANT_MESSAGE_ID,
      partID: TEXT_PART_ID,
      field: 'text',
      delta: '{"file":"src/a.js","line":10,"severity":"high","confidence":"high","body":"Null deref."}',
    },
  },
  {
    type: 'message.part.delta',
    properties: {
      messageID: ASSISTANT_MESSAGE_ID,
      partID: TEXT_PART_ID,
      field: 'text',
      delta: ']}',
    },
  },
  {
    type: 'message.part.updated',
    properties: {
      part: {
        id: TEXT_PART_ID,
        messageID: ASSISTANT_MESSAGE_ID,
        type: 'text',
        text: '{"findings":[{"file":"src/a.js","line":10,"severity":"high","confidence":"high","body":"Null deref."}]}',
      },
    },
  },
  {
    type: 'message.part.updated',
    properties: {
      part: {
        id: STEP_FINISH_PART_ID,
        messageID: ASSISTANT_MESSAGE_ID,
        type: 'step-finish',
        tokens: { total: 20, input: 12, output: 8, reasoning: 3 },
      },
    },
  },
  {
    type: 'message.updated',
    properties: {
      info: {
        id: ASSISTANT_MESSAGE_ID,
        role: 'assistant',
        tokens: { total: 20, input: 12, output: 8, reasoning: 3 },
      },
    },
  },
  { type: 'session.idle', properties: {} },
]

function loadScript() {
  const path = process.env.FAKE_OPENCODE_SCRIPT
  if (!path) return DEFAULT_SCRIPT
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function flag(name, fallback) {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

function authPath() {
  const dataHome = process.env.XDG_DATA_HOME || join(process.env.HOME || '', '.local', 'share')
  return join(dataHome, 'opencode', 'auth.json')
}

function authProviders() {
  try {
    const auth = JSON.parse(readFileSync(authPath(), 'utf8'))
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return []
    return Object.keys(auth)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const override = process.env.FAKE_OPENCODE_PROVIDERS
    return override ? override.split(',').map((provider) => provider.trim()).filter(Boolean) : []
  }
}

function agentNames() {
  const configured = process.env.FAKE_OPENCODE_AGENTS
  return (configured === undefined ? 'build,explore,general,plan' : configured)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

function recordRequest(request) {
  const path = process.env.FAKE_OPENCODE_REQUEST_LOG
  if (!path) return
  try {
    appendFileSync(path, JSON.stringify(request) + '\n')
  } catch {
    // The opt-in test affordance must not change fixture behavior.
  }
}

if (fault === 'missing-binary') process.exit(127)
if (fault === 'nonzero-exit') {
  process.stderr.write('fake opencode failed\n')
  process.exit(3)
}
if (fault === 'partial-then-fail') {
  const partial = (process.env.FAKE_OPENCODE_MODELS || 'stale/model').split(',')[0].trim()
  process.stdout.write(partial)
  process.stderr.write('fake opencode failed\n')
  process.exit(3)
}

if (argv.includes('--version')) {
  process.stdout.write((fault === 'old-version' ? '1.17.0' : version) + '\n')
  process.exit(0)
}

if (argv[0] === 'auth' && argv[1] === 'list') {
  const providers = authProviders()
  process.stdout.write(`┌  Credentials ${authPath()}\n│\n`)
  for (const provider of providers) process.stdout.write(`●  ${provider} api\n│\n`)
  process.stdout.write(`└  ${providers.length} credentials\n`)
  process.exit(0)
}

if (argv[0] === 'models') {
  const models = (process.env.FAKE_OPENCODE_MODELS || 'fake/model-a,fake/model-b,fake/model-c')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
  process.stdout.write(models.join('\n') + '\n')
  process.exit(0)
}

if (argv[0] === 'serve') {
  if (fault === 'port-bound') {
    process.stderr.write('EADDRINUSE: address already in use\n')
    process.exit(1)
  }

  const port = Number(flag('--port', '0'))
  const hostname = flag('--hostname', '127.0.0.1')
  const script = loadScript()
  const sessions = new Map()
  const listeners = new Set()
  let disconnectInjected = false

  function broadcast(payload) {
    const frame = `data: ${JSON.stringify({ payload: { id: 'evt_fake', ...payload } })}\n\n`
    for (const response of listeners) {
      if (response.destroyed) continue
      if (fault === 'partial-line') {
        const midpoint = Math.max(1, Math.floor(frame.length / 2))
        response.write(frame.slice(0, midpoint))
        response.write(frame.slice(midpoint))
      } else {
        response.write(frame)
      }
    }
  }

  async function replay(sessionID) {
    const session = sessions.get(sessionID)
    if (!session || session.replaying) return
    session.replaying = true
    try {
      for (const event of script) {
        if (session.aborted) {
          broadcast({
            type: 'session.error',
            properties: { sessionID, error: { name: 'MessageAbortedError' } },
          })
          return
        }

        const properties = { sessionID, ...event.properties }
        if (event.type === 'message.updated') {
          properties.info = {
            id: ASSISTANT_MESSAGE_ID,
            role: 'assistant',
            ...properties.info,
            sessionID: properties.info?.sessionID ?? sessionID,
          }
        }
        if (event.type === 'message.part.delta') {
          properties.messageID ??= ASSISTANT_MESSAGE_ID
          properties.partID ??= TEXT_PART_ID
          properties.field ??= 'text'
        }
        if (event.type === 'message.part.updated') {
          properties.part = {
            id: TEXT_PART_ID,
            messageID: ASSISTANT_MESSAGE_ID,
            sessionID,
            type: 'text',
            ...properties.part,
            sessionID: properties.part?.sessionID ?? sessionID,
          }
        }
        if (fault === 'malformed-json' && event.type === 'message.part.delta') {
          properties.delta = 'not json at all'
        }
        broadcast({ type: event.type, properties })

        if (
          fault === 'sse-disconnect'
          && !disconnectInjected
          && event.type === 'message.part.delta'
        ) {
          disconnectInjected = true
          for (const response of listeners) {
            response.destroy()
            listeners.delete(response)
          }
          break
        }
        await sleep(Number(process.env.FAKE_OPENCODE_EVENT_DELAY_MS || 5))
      }
    } finally {
      session.replaying = false
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/doc' && req.method === 'GET') {
      if (fault === 'no-health') return send(503, { error: 'health unavailable' })
      return send(200, { openapi: '3.0.0', paths: { '/session': {}, '/global/event': {} } })
    }

    if (url.pathname === '/agent' && req.method === 'GET') {
      return send(200, agentNames().map((name) => ({ name })))
    }

    if (url.pathname === '/global/event' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ payload: { id: 'evt_fake', type: 'server.connected', properties: {} } })}\n\n`)
      listeners.add(res)
      req.on('close', () => listeners.delete(res))
      if (fault === 'sse-disconnect') {
        const pending = [...sessions.entries()].find(([, session]) => session.prompted && !session.replaying)
        if (pending) void replay(pending[0])
      }
      return
    }

    if (url.pathname === '/session' && req.method === 'POST') {
      const id = `ses_fake_${sessions.size + 1}`
      sessions.set(id, { aborted: false })
      recordRequest({ type: 'session-create', sessionID: id })
      req.resume()
      return send(200, { id, directory: process.cwd(), time: { created: 0, updated: 0 } })
    }

    const match = url.pathname.match(/^\/session\/([^/]+)\/(prompt_async|abort)$/)
    if (match && req.method === 'POST') {
      const [, id, action] = match
      if (!sessions.has(id)) sessions.set(id, { aborted: false, prompted: false, replaying: false })
      recordRequest({ type: action === 'prompt_async' ? 'prompt' : 'abort', sessionID: id })
      req.resume()
      if (action === 'abort') {
        sessions.get(id).aborted = true
        return send(200, true)
      }
      sessions.get(id).prompted = true
      void replay(id)
      return send(200, { messageID: ASSISTANT_MESSAGE_ID })
    }

    return send(404, { error: 'not found' })
  })

  const start = async () => {
    if (fault === 'slow-start') await sleep(Number(process.env.FAKE_OPENCODE_START_DELAY_MS || 3000))
    server.listen(port, hostname, () => {
      process.stdout.write(`opencode server listening on http://${hostname}:${server.address().port}\n`)
    })
  }
  void start()
} else {
  process.stderr.write(`fake opencode: unsupported invocation: ${argv.join(' ')}\n`)
  process.exit(2)
}
