function redact(text, secrets) {
  let result = String(text)
  for (const secret of secrets) {
    if (secret) result = result.split(String(secret)).join('[REDACTED]')
  }
  return result
}

export class HttpError extends Error {
  constructor(status, body, url, secrets = []) {
    const safeBody = redact(body, secrets)
    const safeUrl = redact(url, secrets)
    super(`HTTP ${status} from ${safeUrl}: ${safeBody.slice(0, 400)}`)
    this.name = 'HttpError'
    this.status = status
    this.body = safeBody
  }
}

export function parseSseChunk(buffer) {
  const events = []
  let rest = buffer
  while (true) {
    const idx = rest.indexOf('\n\n')
    if (idx === -1) break
    const frame = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      try { events.push(JSON.parse(data)) } catch { /* ignore malformed frames */ }
    }
  }
  return { events, rest }
}

export class OpencodeClient {
  constructor(baseUrl, { password, username = 'opencode', fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.password = password
    this.username = username
    this.fetch = fetchImpl
  }

  headers(extra = {}) {
    const headers = { ...extra }
    if (this.password) {
      headers.authorization = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64')
    }
    return headers
  }

  async request(method, path, body, { timeoutMs = 60000, signal } = {}) {
    const url = this.baseUrl + path
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
    try {
      const response = await this.fetch(url, {
        method,
        signal: controller.signal,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      if (!response.ok) {
        const credentials = [
          this.username,
          this.password,
          `${this.username}:${this.password}`,
          Buffer.from(`${this.username}:${this.password}`).toString('base64'),
        ]
        throw new HttpError(response.status, text, url, credentials)
      }
      return text ? JSON.parse(text) : null
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abort)
    }
  }

  doc() { return this.request('GET', '/doc') }

  async health({ timeoutMs = 2000 } = {}) {
    try { await this.request('GET', '/doc', undefined, { timeoutMs }); return true } catch { return false }
  }

  createSession(body = {}) { return this.request('POST', '/session', body) }

  promptAsync(sessionID, body) {
    return this.request('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, body)
  }

  async abort(sessionID) {
    await this.request('POST', `/session/${encodeURIComponent(sessionID)}/abort`, {})
  }

  async events({ signal, onEvent }) {
    if (signal?.aborted) return

    const url = this.baseUrl + '/global/event'
    let reader
    try {
      const response = await this.fetch(url, {
        headers: this.headers({ accept: 'text/event-stream' }),
        signal,
      })
      if (!response.ok) {
        const credentials = [
          this.username,
          this.password,
          `${this.username}:${this.password}`,
          Buffer.from(`${this.username}:${this.password}`).toString('base64'),
        ]
        throw new HttpError(response.status, await response.text(), url, credentials)
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseSseChunk(buffer)
        buffer = parsed.rest
        for (const event of parsed.events) if (event.payload) onEvent(event.payload)
      }
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') return
      throw error
    } finally {
      if (reader) await reader.cancel().catch(() => {})
    }
  }
}
