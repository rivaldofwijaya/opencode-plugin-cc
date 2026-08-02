// Wire types for the opencode HTTP server, transcribed from GET /doc on 1.18.11.
// Documentation only — this file is never compiled or imported at runtime.

export interface SessionCreateRequest {
  title?: string
  agent?: string
  parentID?: string
  model?: { providerID: string; id: string; variant?: string }
  permission?: Record<string, unknown>
}

export interface Session {
  id: string
  directory?: string
  parentID?: string
  title?: string
}

export interface TextPartInput { type: 'text'; text: string }
export interface FilePartInput { type: 'file'; url: string; mime?: string; filename?: string }

export interface PromptAsyncRequest {
  parts: Array<TextPartInput | FilePartInput>
  messageID?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  system?: string
  tools?: Record<string, boolean>
}

export interface EventPayload<T = Record<string, unknown>> {
  id: string
  type: string
  properties: T
}

// Types observed in practice, in the order a job sees them:
export type StepStarted = EventPayload<{ sessionID: string; assistantMessageID: string; agent?: string; model?: { providerID: string; modelID: string } }>
export type ToolCalled = EventPayload<{ sessionID: string; callID: string; tool: string; input?: Record<string, unknown> }>
export type TextDelta = EventPayload<{ sessionID: string; assistantMessageID: string; textID: string; delta?: string }>
export type MessageUpdated = EventPayload<{ sessionID: string; info: { role: string; tokens?: { input?: number; output?: number }; cost?: number } }>
export type SessionIdle = EventPayload<{ sessionID: string }>
export type SessionError = EventPayload<{ sessionID: string; error?: { name?: string; data?: unknown } }>
