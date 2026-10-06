// What the feed keeps for the session. Every field is read from an engine event
// (tool.call, turn.start, turn.complete, session.append, agent.spawn, agent.list); none is invented.

/** The three presets over the settings; `custom` once a setting moves off a preset. */
export type Mode = 'clean' | 'normal' | 'raw' | 'custom'

/** Kinds a person can switch off whole (`/feed hide <kind>`). */
export type Kind = 'you' | 'said' | 'tool' | 'agent' | 'question' | 'peer' | 'helper' | 'search'

/** The chat view settings. */
export type Settings = {
  raw: boolean
  /** clear after the turn: a spent turn's machinery leaves */
  clear: boolean
  /** keep every card: overrides clear, spent rows stay as they were drawn */
  keep: boolean
  /** group a turn's machinery into one line "{n} steps this turn" */
  group: boolean
  /** card style: expanded (calls listed under their run), subtle (one line, chevron, chips), line (words only) */
  style: 'expanded' | 'subtle' | 'line'
  /** commands in the chat: one row per run of calls, or one row per call */
  commands: 'grouped' | 'each'
  /** after a command finishes: clear it (a spent turn keeps the run's line) or keep it */
  after: 'clear' | 'keep'
  /** kinds switched off whole */
  hide: Kind[]
}

/**
 * One tool call of the main conversation, as tool.call carried it. `words` and `past` are
 * plain words (never a command, path or id).
 */
export type Call = {
  id: string
  tool: string
  turnId: string
  words: string
  past: string
  startedAt: number
  question?: string
  answer?: string
  pairs?: { q: string; a: string }[]
  lines?: number
  out?: string
  /** an error a hook gave instead of running it (a PreToolUse deny) */
  refused?: boolean
  done: boolean
  errored: boolean
}

/** A run: the calls between two pieces of Claude's text. */
export type Run = { turnId: string; calls: Call[] }

/** A turn: from your message (or a message from another session) to the next, or an interrupt. */
export type Turn = { first: string | null; calls: number; done: number; open: boolean; interrupted: boolean }

/** The live line: the call in flight, with its own clock. */
export type Live = { turnId: string; startedAt: number; steps: number; label: string; tool: string; callAt: number }

/** A helper (an Agent call): its own row and its place in the helpers pane. */
export type Helper = { callId: string; name: string; agentId: string | null; status: 'running' | 'finished' | 'failed' | 'stopped'; startedAt: number; endedAt: number | null; now: string; kind?: string }

/** Messages from other sessions or agents that arrived together. */
export type Burst = { members: { uuid: string; name: string; at: number }[] }

declare module 'claude-code' {
  interface PluginState {
    'chat-clean': {
      settings: Settings
      live: Live | null
      tick: number
      spin: number
      sweep: number
      bg: { id: string; words: string; at: number }[]
      helpers: number
      cursor: string | null
      turnNow: string | null
      burstOpen: string | null
      helperIds: string[]
      callRun: StateFamily<string>
      run: StateFamily<Run>
      turn: StateFamily<Turn>
      open: StateFamily<boolean>
      helper: StateFamily<Helper>
      agentCall: StateFamily<string>
      peerBurst: StateFamily<string>
      burst: StateFamily<Burst>
    }
  }
}
