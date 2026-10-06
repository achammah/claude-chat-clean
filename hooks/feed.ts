// Pure rules of the chat feed: labels, counts, the live line. No `$`, no model call.
//
// A label never shows a raw command, a path or an id. Order: the call's own `description`
// (cleaned of paths and ids); else a plain verb for the tool, with a file's base name where the
// tool works on one file. The same call always reads the same way.

import type { Call, Kind, Live, Mode, Settings } from '../types'

export const PRESETS = ['clean', 'normal', 'raw'] as const
export type Preset = (typeof PRESETS)[number]
export const isPreset = (s: string): s is Preset => (PRESETS as readonly string[]).includes(s)
export const KINDS: readonly Kind[] = ['you', 'said', 'tool', 'agent', 'question', 'peer', 'helper', 'search']

/** The presets over the settings; clean is the default. */
export const PRESET: Record<Preset, Settings> = {
  clean: { raw: false, clear: true, keep: false, group: true, style: 'subtle', commands: 'grouped', after: 'clear', hide: [] },
  normal: { raw: false, clear: false, keep: true, group: false, style: 'subtle', commands: 'grouped', after: 'keep', hide: [] },
  raw: { raw: true, clear: false, keep: true, group: false, style: 'expanded', commands: 'each', after: 'keep', hide: [] },
}
export function modeOf(s: Settings): Mode {
  for (const p of PRESETS) {
    const q = PRESET[p]
    if (p === 'raw' ? s.raw : !s.raw && q.clear === s.clear && q.keep === s.keep && q.group === s.group && q.style === s.style && q.commands === s.commands && q.after === s.after && s.hide.length === 0) return p
  }
  return 'custom'
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const firstLine = (s: string) => (s.split('\n').find(l => l.trim() !== '') ?? '').trim()
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p
const obj = (input: unknown) => (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

export const isAgentTool = (tool: string) => tool === 'Agent' || tool === 'Task'
const SHELL = new Set(['Bash', 'PowerShell'])
const EDIT = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SEARCH = new Set(['Grep', 'Glob'])

/**
 * Plain words only: a path becomes its base name, an id (a UUID, a long hex or a long token
 * mixing letters and digits) is dropped, an assignment `T=<id>` with it.
 */
export function plain(text: string): string {
  return firstLine(text)
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*=\S+/g, ' ')
    .replace(/(?:~|\.{0,2})?\/[^\s'"`]+/g, m => {
      const b = baseName(m)
      return b === '' || b === '~' ? ' ' : b
    })
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ')
    .replace(/\b[0-9a-f]{12,}\b/gi, ' ')
    .replace(/\b(?=[A-Za-z0-9_-]{20,}\b)(?=\S*\d)\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
}

const desc = (i: Record<string, unknown>) => {
  const d = str(i.description)
  const p = d ? plain(d) : ''
  return p.length >= 3 ? p : undefined
}
const hostOf = (i: Record<string, unknown>) => {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(str(i.url) ?? '')
  return m ? m[1]!.replace(/^www\./, '') : undefined
}
const fileOf = (i: Record<string, unknown>) => {
  const fp = str(i.file_path) ?? str(i.notebook_path)
  return fp ? baseName(fp) : undefined
}
/** mcp__server__tool as `server tool`; a built-in keeps its name. */
export function toolName(tool: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? `${m[1]!.replace(/^claude_ai_/, '').replace(/_/g, ' ')} ${m[2]!.replace(/_/g, ' ')}` : tool
}

/** What the call is doing, present tense: "Running the tests", "Reading app.py". */
export function stepWords(tool: string, input: unknown): string {
  const i = obj(input)
  const d = desc(i)
  if (d) return d
  const f = fileOf(i)
  if (SHELL.has(tool)) return 'Running a shell command'
  if (tool === 'Read') return f ? `Reading ${f}` : 'Reading a file'
  if (EDIT.has(tool)) return f ? `Editing ${f}` : 'Editing a file'
  if (SEARCH.has(tool)) return 'Searching the code'
  if (tool === 'WebSearch') return str(i.query) ? `Searching the web for ${plain(String(i.query))}` : 'Searching the web'
  if (tool === 'WebFetch') return hostOf(i) ? `Opening ${hostOf(i)}` : 'Opening a web page'
  if (tool === 'Skill') return str(i.skill) ? `Loading the ${plain(String(i.skill))} skill` : 'Loading a skill'
  if (isAgentTool(tool)) return 'Asking a helper'
  if (tool === 'AskUserQuestion') return 'Asking you a question'
  if (tool === 'TodoWrite') return 'Updating the todo list'
  return `Using ${toolName(tool)}`
}

/** What the call did, past tense, for a run of one finished call. */
export function pastWords(tool: string, input: unknown): string {
  const i = obj(input)
  const d = desc(i)
  if (d) return d
  const f = fileOf(i)
  if (SHELL.has(tool)) return 'Ran a shell command'
  if (tool === 'Read') return f ? `Read ${f}` : 'Read a file'
  if (EDIT.has(tool)) return f ? `Edited ${f}` : 'Edited a file'
  if (SEARCH.has(tool)) return 'Searched the code'
  if (tool === 'WebSearch') return 'Searched the web'
  if (tool === 'WebFetch') return hostOf(i) ? `Opened ${hostOf(i)}` : 'Opened a web page'
  if (tool === 'Skill') return str(i.skill) ? `Loaded the ${plain(String(i.skill))} skill` : 'Loaded a skill'
  if (isAgentTool(tool)) return 'Asked a helper'
  if (tool === 'TodoWrite') return 'Updated the todo list'
  return `Used ${toolName(tool)}`
}

/** The question an AskUserQuestion call put, as written for the person. */
export function questionOf(input: unknown): string | undefined {
  const qs = Array.isArray(obj(input).questions) ? (obj(input).questions as Record<string, unknown>[]) : []
  const q = qs[0] && str(qs[0].question)
  return q ? firstLine(q) : undefined
}

/** The answer an AskUserQuestion result carries: its `answers` values, else the typed `response`. */
export function answerOf(result: unknown): string | undefined {
  const r = obj(result)
  const a = obj(r.answers)
  const vals = Object.values(a).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  if (vals.length > 0) return vals.join(', ')
  return str(r.response)
}

/** "Ran 3 shell commands · read 1 file": counts by kind, most first, then by name. */
export function runCounts(calls: readonly Pick<Call, 'tool'>[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) counts.set(kindOf(c.tool), (counts.get(kindOf(c.tool)) ?? 0) + 1)
  const parts = [...counts]
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .map(([k, n]) => countWords(k, n))
  const line = parts.join(' · ')
  return line === '' ? '' : line[0]!.toUpperCase() + line.slice(1)
}

const kindOf = (tool: string) => (SHELL.has(tool) ? 'shell' : EDIT.has(tool) ? 'Edit' : SEARCH.has(tool) ? 'Grep' : isAgentTool(tool) ? 'Agent' : tool)
function countWords(kind: string, n: number): string {
  const s = n === 1 ? '' : 's'
  switch (kind) {
    case 'shell':
      return `ran ${n} shell command${s}`
    case 'Read':
      return `read ${n} file${s}`
    case 'Edit':
      return `made ${n} edit${s}`
    case 'Grep':
      return `searched the code ${n === 1 ? 'once' : `${n} times`}`
    case 'Skill':
      return `loaded ${n} skill${s}`
    case 'WebSearch':
      return `searched the web ${n === 1 ? 'once' : `${n} times`}`
    case 'WebFetch':
      return `opened ${n} web page${s}`
    case 'Agent':
      return `asked ${n} helper${s}`
    default:
      return `used ${toolName(kind)} ${n === 1 ? 'once' : `${n} times`}`
  }
}

/** 8s · 1m 12s · 1h 3m */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * The live line: the call in flight with its own clock, then the turn's step count, then
 * running helpers: "Running the tests · 12s · step 4 · 2 helpers working". With `namesCall`
 * false (grouping off: the run line names the call) it says "Working" instead.
 */
export function liveLine(live: Live | null, now: number, helpers: number, isWriting: boolean, namesCall: boolean): string {
  const named = namesCall && live !== null && live.label !== ''
  const words = isWriting ? 'Writing' : named ? live!.label : live && live.steps > 0 ? 'Working' : 'Thinking'
  const parts = [words]
  if (live) parts.push(elapsed(now - (named && !isWriting ? live.callAt : live.startedAt)))
  if (live && live.steps > 0) parts.push(`step ${live.steps}`)
  if (helpers > 0) parts.push(`${helpers} helper${helpers === 1 ? '' : 's'} working`)
  return parts.join(' · ')
}

/** A refusal a hook wrote as the call's error ("PreToolUse:Agent hook error: ..."). */
export const isRefusal = (text: string) => /\b(PreToolUse|PermissionRequest)(:\S+)? hook (error|blocked|denied)|blocked by (a )?hook|hook .*denied/i.test(text)

/** 13:18, local time. */
export function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "{n} steps this turn", with the singular. */
export const stepsLine = (n: number) => `${n} step${n === 1 ? '' : 's'} this turn`

/** "{n} messages · {names} · last {clock}". */
export function peerFold(names: string[], last: number): string {
  const uniq = [...new Set(names)]
  return `${names.length} messages · ${uniq.join(', ')} · last ${clock(last)}`
}

/** Who sent a delivery, from its envelope's attributes. */
export function senderOf(text: string): string | undefined {
  const m = /\b(?:from|teammate_id|name)="([^"]+)"/.exec(text)
  return m ? plain(m[1]!) : undefined
}

/** A hook's text as one label: its first line that says something. */
export function hookLabel(text: string): string {
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s === '' || s.endsWith('feedback:') || s.endsWith('context:')) continue
    if (s.startsWith('Stop hook') || s.startsWith('UserPromptSubmit')) continue
    return s.slice(0, 110)
  }
  return 'hook feedback'
}
export const isHookText = (text: string) => /^(Stop hook feedback|UserPromptSubmit|PostToolUse|PreToolUse)[^\n]*:/.test(text.trim())

/**
 * What one call's row draws, by the settings: the pure verdict.
 *  turn: the turn's one line "{n} steps this turn ›" (the first machinery call of the turn)
 *  run:  its run's one line (the first call of the run)
 *  call: its own line
 *  hide: nothing
 * Helpers and questions never reach here: they always draw their own row.
 */
export type Verdict = 'turn' | 'run' | 'call' | 'hide'
export function verdict(s: Settings, r: { firstOfTurn: boolean; firstOfRun: boolean; live: boolean; spent: boolean; turnOpened: boolean }): Verdict {
  const visible = !r.spent || s.keep || !s.clear
  if (s.group && !r.turnOpened && !(r.spent && s.keep)) return r.firstOfTurn ? 'turn' : 'hide'
  if (!visible && !r.turnOpened) return 'hide'
  if (s.group && r.live && !r.turnOpened) return 'hide'
  if (s.commands === 'grouped') return r.firstOfRun ? 'run' : 'hide'
  if (r.spent && s.after === 'clear' && !s.keep && !r.turnOpened) return r.firstOfRun ? 'run' : 'hide'
  return 'call'
}

/** Cut at a word, never inside one, with "…" when anything was left out. */
export function fit(text: string, room: number): string {
  const chars = [...text]
  if (chars.length <= room) return text
  const max = Math.max(4, room - 1)
  const head = chars.slice(0, max).join('')
  const at = head.lastIndexOf(' ')
  const cut = at >= max * 0.5 ? head.slice(0, at) : head
  return cut.replace(/[\s·,;:.-]+$/, '') + '…'
}

/** The first line of a message that is not empty, for a one-line message row. */
export function headLine(text: string, room: number): string {
  return fit(noPaths(firstLine(readable(text.replace(/<[^>]+>/g, ' ')))), Math.max(8, room))
}

/** An absolute path in a one-line label shrinks to its last part: a label never shows a private folder. */
export function noPaths(text: string): string {
  return text.replace(/(?:~|\/(?:Users|home|private|tmp|var|opt|Volumes))(?:\/[^\s/'"`)]+)+/g, m => m.split('/').filter(Boolean).pop() ?? m)
}

/** A helper's status JSON (`{"type":"idle_notification",…,"result":"…"}`) reads as words: the state,
 *  then its result or summary, never the raw object. */
function readable(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{')) return text
  try {
    const j = JSON.parse(t) as Record<string, unknown>
    const kind = typeof j.type === 'string' ? j.type.replace(/_notification$/, '').replace(/_/g, ' ') : ''
    const body = [j.summary, j.result, j.message, j.text].find(v => typeof v === 'string' && v.trim()) as string | undefined
    return [kind, body ? firstLine(body) : ''].filter(Boolean).join(' · ') || text
  } catch { return text }
}

/** One helper message inside a teammate block: who sent it, its state, its one-line summary, its
 *  markdown body. Owner, 6 Oct: helper reports drew as raw JSON under "you" ('this needs proper
 *  formatting, esp. since the json format allows it'). */
export type Frame = { from?: string; state?: string; at?: number; summary?: string; body: string }

function frameOf(body: string, attrs: Record<string, string>): Frame {
  const t = body.trim()
  const f: Frame = { from: attrs.teammate_id ?? attrs.from, summary: attrs.summary, body: t }
  if (!t.startsWith('{')) return f
  try {
    const j = JSON.parse(t) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const kind = str(j.type)?.replace(/_notification$/, '').replace(/_/g, ' ')
    const at = str(j.timestamp) ? Date.parse(String(j.timestamp)) : NaN
    return {
      from: str(j.from) ?? f.from,
      state: kind === 'idle' ? 'waiting' : kind,
      at: Number.isFinite(at) ? at : undefined,
      summary: f.summary ?? str(j.summary),
      body: str(j.result) ?? str(j.message) ?? str(j.text) ?? str(j.reason) ?? '',
    }
  } catch {
    return f
  }
}

/** The frames of a stored message's raw text (`<teammate-message teammate_id=… summary=…>…</…>`). */
export function framesOfRaw(raw: string): Frame[] {
  const out: Frame[] = []
  for (const m of raw.matchAll(/<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g)) {
    const attrs: Record<string, string> = {}
    for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
    out.push(frameOf(m[2]!, attrs))
  }
  return out
}

/** The same from a row's text when the stored message was not seen (a resumed session): each
 *  one-line JSON object is a frame; the text between two of them is one plain frame whose first
 *  line is its summary. Empty when the text holds no helper JSON. */
export function framesOfView(text: string): Frame[] {
  if (!/^\s*\{"type":"/m.test(text)) return []
  const out: Frame[] = []
  let plain: string[] = []
  const flush = () => {
    const t = plain.join('\n').trim()
    plain = []
    if (!t) return
    const [head, ...rest] = t.split('\n')
    out.push({ summary: head!.trim(), body: rest.join('\n').trim() })
  }
  for (const l of text.split('\n')) {
    if (/^\s*\{"type":"/.test(l)) {
      flush()
      out.push(frameOf(l, {}))
    } else plain.push(l)
  }
  flush()
  return out
}

/** A body cut to its first paragraph, with how many lines were left out. */
export function leadOf(body: string): { lead: string; more: number } {
  const t = body.replace(/\r/g, '').trim()
  const at = t.indexOf('\n\n')
  if (at < 0) return { lead: t, more: 0 }
  return { lead: t.slice(0, at), more: t.slice(at + 2).split('\n').filter(l => l.trim()).length }
}

/** A call that never joins a run: its own line (a helper, a question). */
export const standsAlone = (tool: string) => isAgentTool(tool) || tool === 'AskUserQuestion'

export type FeedCommand =
  | { kind: 'page' }
  | { kind: 'close' }
  | { kind: 'preset'; preset: Preset }
  | { kind: 'set'; patch: Partial<Settings>; said: string }
  | { kind: 'hide' | 'show'; what: Kind }
  | { kind: 'bad' }

const ONOFF: Record<string, boolean> = { on: true, off: false, yes: true, no: false, true: true, false: false }

export function parseFeed(args: string): FeedCommand {
  const w = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (w.length === 0) return { kind: 'page' }
  if (w.length === 1 && w[0] === 'close') return { kind: 'close' }
  if (w.length === 1 && isPreset(w[0]!)) return { kind: 'preset', preset: w[0] }
  const [k, v] = [w[0]!, w[1] ?? '']
  if ((k === 'hide' || k === 'show') && (KINDS as readonly string[]).includes(v)) return { kind: k, what: v as Kind }
  if (['clear', 'keep', 'group'].includes(k) && v in ONOFF) return { kind: 'set', patch: { [k]: ONOFF[v] } as Partial<Settings>, said: `${k} ${ONOFF[v] ? 'on' : 'off'}` }
  if (k === 'style' && ['expanded', 'subtle', 'line'].includes(v)) return { kind: 'set', patch: { style: v as Settings['style'] }, said: `style ${v}` }
  if (k === 'commands' && ['grouped', 'each'].includes(v)) return { kind: 'set', patch: { commands: v as Settings['commands'] }, said: `commands ${v}` }
  if (k === 'after' && ['clear', 'keep'].includes(v)) return { kind: 'set', patch: { after: v as Settings['after'] }, said: `after ${v}` }
  return { kind: 'bad' }
}

export const USAGE =
  '/feed opens the settings · /feed clean | normal | raw · /feed group on|off · /feed clear on|off · /feed keep on|off · /feed style expanded|subtle|line · /feed commands grouped|each · /feed after clear|keep · /feed hide|show <kind> · /feed close'

export const PRESET_HELP: Record<Preset, string> = {
  clean: "your messages, Claude's replies, and one line per turn for the work",
  normal: 'each run of tool calls is one line with counts',
  raw: "Claude Code's own drawing",
}

/** An API error reply as one quiet line saying what happened, whose problem it is, and what
 * happens next. `null` for a reply that is not an error. */
export function errorLine(text: string): { words: string; act: boolean; guard?: boolean } | null {
  const t = (text || '').trim()
  // owner, 6 Oct: 'have in the one line also what happened … if I have a big issue with safeguard and I have
  // instructions on how to move back up the conversation or switch model I want to see it'
  const guardWho = t.match(/^(?:API Error:\s*)?(.{1,40}?)'s safeguards/i)?.[1]
  if (guardWho && /stopped the response above|continuing/i.test(t))
    return { words: `${guardWho}'s safeguards cut the reply above · Claude continues · esc esc goes back to an earlier message`, act: false, guard: true }
  if (/stopped by a safety classifier/i.test(t))
    return { words: 'A safeguard cut the reply above · Claude continues · esc esc goes back to an earlier message', act: false, guard: true }
  if (!/^(API Error|Error:|Request timed out|Connection error|Claude AI usage limit|Credit balance|Invalid API key|Please run \/login|Prompt is too long)/i.test(t)) return null
  const s = t.toLowerCase()
  if (/safeguards|usage policy|\/legal\/aup/.test(s))
    return { words: `${guardWho ?? 'The model'}'s safeguards stopped this reply · often a false alarm · esc esc to edit your message, or /model to switch`, act: true, guard: true }
  if (/529|overloaded/.test(s)) return { words: "Claude's servers are busy · not your setup · Claude Code retries, or send again", act: false }
  if (/usage limit|rate.?limit|429/.test(s)) {
    const reset = t.match(/reset[s]?\s*(?:at)?\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i)
    return { words: `Usage limit reached${reset ? ` · resets ${reset[1]}` : ''} · nothing is lost · /model to switch`, act: true }
  }
  if (/prompt is too long|context length|too many tokens/.test(s)) return { words: 'This chat is too long for the model · run /compact · nothing is lost', act: true }
  if (/401|403|authentication|login|api key|oauth/.test(s)) return { words: 'Login needed · run /login · nothing is lost', act: true }
  if (/credit|billing/.test(s)) return { words: 'Billing problem on the account · nothing is lost', act: true }
  if (/connection|econn|enotfound|fetch failed|network|socket|timed out|timeout/.test(s)) return { words: 'Connection lost · check your internet · send again to retry', act: false }
  if (/5\d\d|server_error|internal/.test(s)) return { words: "Server error on Claude's side · your work is kept · send a message to try again", act: false }
  if (/400|invalid_request|max_output/.test(s)) return { words: 'Claude refused this request · ctrl+o shows why · esc esc to edit your message', act: true }
  return { words: 'Claude Code hit an error · ctrl+o shows it', act: false }
}

/** Each answered question as one line, question → answer.
 * The question is cut to its first sentence. Pairs come from the result's answers map
 * (question text → answer); one pair per question of the card. */
export function pairsOf(result: unknown, input?: unknown): { q: string; a: string }[] {
  const a = obj(obj(result).answers)
  const out = Object.entries(a)
    .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
    .map(([q, v]) => ({ q: shortQuestion(q), a: String(v).replace(/\s+/g, ' ').trim() }))
  if (out.length) return out
  const one = answerOf(result)
  return one ? [{ q: shortQuestion(questionOf(input) ?? 'a question'), a: one.replace(/\s+/g, ' ').trim() }] : []
}

export function shortQuestion(q: string): string {
  const t = (q || '').replace(/\s+/g, ' ').trim()
  const m = t.match(/^(.*?[?:])(\s|$)/) ?? t.match(/^(.*?\.)(\s|$)/)
  return (m ? m[1]! : t).replace(/[?:.]$/, '')
}

/** The desktop band's small icons: a row of tinted pills built from the mod's own elements. */
const ICON: Record<string, string> = {
  clock: '<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 4.2V7l2 1.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  cal: '<rect x="2" y="3" width="10" height="9" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6h10M5 1.6v2.6M9 1.6v2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  flask: '<path d="M5.4 2h3.2M6 2v3.4L2.8 11a1 1 0 0 0 .9 1.5h6.6a1 1 0 0 0 .9-1.5L8 5.4V2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
}

/** One small icon as its own svg document, coloured (an image cannot inherit a colour). */
export function iconSvg(name: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${(ICON[name] ?? '').replace(/currentColor/g, color)}</svg>`
}

