import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  classifySessionError,
  createEventAccumulator,
  streamIdleTimeoutMs,
} from '../../scripts/lib/job-control.mjs'

const capturePath = fileURLToPath(new URL(
  '../captures/opencode-1.18.13-task-stream.jsonl',
  import.meta.url,
))

const message = (id, role, tokens) => ({
  type: 'message.updated',
  properties: { info: { id, role, ...(tokens ? { tokens } : {}) } },
})

const part = (id, messageID, type, extra = {}) => ({
  type: 'message.part.updated',
  properties: {
    part: { id, messageID, sessionID: 'ses_test', type, ...extra },
  },
})

const delta = (partID, messageID, value) => ({
  type: 'message.part.delta',
  properties: {
    sessionID: 'ses_test',
    messageID,
    partID,
    field: 'text',
    delta: value,
  },
})

test('reasoning deltas before type announcement never reach result.md', () => {
  const accumulator = createEventAccumulator()
  accumulator.apply(message('msg_assistant', 'assistant'))
  accumulator.apply(delta('prt_reasoning', 'msg_assistant', 'private reasoning'))
  accumulator.apply(part('prt_reasoning', 'msg_assistant', 'reasoning', { text: 'private reasoning' }))
  accumulator.apply(part('prt_text', 'msg_assistant', 'text', { text: 'ready' }))

  assert.equal(accumulator.resultText(), 'ready')
  assert.doesNotMatch(accumulator.resultText(), /private reasoning/)
})

test("the user's own text part never reaches result.md", () => {
  const accumulator = createEventAccumulator()
  accumulator.apply(message('msg_user', 'user'))
  accumulator.apply(part('prt_user', 'msg_user', 'text', { text: 'private prompt' }))
  accumulator.apply(message('msg_assistant', 'assistant'))
  accumulator.apply(part('prt_text', 'msg_assistant', 'text', { text: 'ready' }))

  assert.equal(accumulator.resultText(), 'ready')
  assert.doesNotMatch(accumulator.resultText(), /private prompt/)
})

test('a part whose message role never resolves is excluded', () => {
  const accumulator = createEventAccumulator()
  accumulator.apply(part('prt_unknown', 'msg_unknown', 'text', { text: 'must not leak' }))

  assert.equal(accumulator.resultText(), '')
})

test('snapshots beat deltas and deltas are a fallback for text parts without snapshots', () => {
  const snapshotWins = createEventAccumulator()
  snapshotWins.apply(message('msg_assistant', 'assistant'))
  snapshotWins.apply(part('prt_snapshot', 'msg_assistant', 'text'))
  snapshotWins.apply(delta('prt_snapshot', 'msg_assistant', 'delta text'))
  snapshotWins.apply(part('prt_snapshot', 'msg_assistant', 'text', { text: 'snapshot text' }))
  assert.equal(snapshotWins.resultText(), 'snapshot text')

  const fallback = createEventAccumulator()
  fallback.apply(message('msg_assistant', 'assistant'))
  fallback.apply(part('prt_fallback', 'msg_assistant', 'text'))
  fallback.apply(delta('prt_fallback', 'msg_assistant', 'fallback text'))
  assert.equal(fallback.resultText(), 'fallback text')
})

test('steps and tools count distinct completed part ids', () => {
  const accumulator = createEventAccumulator()
  accumulator.apply(part('prt_step', 'msg_assistant', 'step-finish'))
  accumulator.apply(part('prt_step', 'msg_assistant', 'step-finish'))
  accumulator.apply(part('prt_tool', 'msg_assistant', 'tool'))
  accumulator.apply(part('prt_tool', 'msg_assistant', 'tool'))
  accumulator.apply(message('msg_assistant', 'assistant', { input: 12, output: 7 }))

  assert.deepEqual(accumulator.counters(), {
    steps: 1,
    tools: 1,
    inputTokens: 12,
    outputTokens: 7,
  })
})

test('session.error uses error.data.message and preserves cancellation classification', () => {
  assert.deepEqual(
    classifySessionError({
      type: 'session.error',
      properties: {
        error: { name: 'UnknownError', data: { message: 'Agent not found' } },
      },
    }),
    { state: 'failed', error: 'Agent not found' },
  )
  assert.deepEqual(
    classifySessionError({
      type: 'session.error',
      properties: { error: { name: 'MessageAbortedError' } },
    }),
    { state: 'cancelled', error: 'MessageAbortedError' },
  )
})

test('stream idle timeout accepts a positive finite integer override', () => {
  assert.equal(streamIdleTimeoutMs({ OPENCODE_STREAM_IDLE_MS: '3750' }), 3750)
})

test('stream idle timeout rejects invalid overrides and keeps the default', () => {
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', 'not-a-number']) {
    assert.equal(streamIdleTimeoutMs({ OPENCODE_STREAM_IDLE_MS: value }), 120_000, value)
  }
})

test('replaying the real task capture produces exactly the assistant answer', async () => {
  const contents = await readFile(capturePath, 'utf8')

  const accumulator = createEventAccumulator()
  for (const line of contents.trim().split(/\r?\n/)) {
    const event = JSON.parse(line)
    // sync records are server envelopes duplicating the direct payload record;
    // feed the actual payload records once, in their captured file order.
    if (event.type !== 'sync') accumulator.apply(event)
  }

  assert.equal(accumulator.resultText(), 'ready')
  assert.doesNotMatch(accumulator.resultText(), /We need to respond/)
})
