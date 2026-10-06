// chat-clean: a clean chat view for Claude Code. Your messages and Claude's replies stay; the
// machinery (tool calls, results, timers) folds into one quiet line per turn.
//
// Three presets over a handful of settings:
//   clean   clear after the turn on, keep every card off, group the turn into one line on,
//           card style subtle, commands grouped, after a command finishes: clear
//   normal  each run of calls is one line with counts, nothing cleared
//   raw     Claude Code's own drawing
// `/feed` opens the settings page; `/feed <preset>` and `/feed <setting> <value>` work mid-turn.
//
// Each transcript row decides alone (there is no turn-level component), so the turn, run and
// helper bookkeeping lives in $.state, written by events and only read while drawing.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { Burst, Call, Helper, Kind, Live, Mode, Run, Settings, Turn } from '../types'
import * as F from './feed'

export type { Burst, Call, Helper, Kind, Live, Mode, Run, Settings, Turn }

const PANE = 'chat-clean-feed'
const LANES = 'chat-clean-helpers'
const ACCENT = '#d97757'
// inks set by the theme: light themes get darker steps
let PEER = '#a78bfa'
let CHIP = '#3b3b3b'
let GREEN_I = '#7fbf8f'
let VIOLET_I = '#b9acec'
let RED_I = '#e06c6c'
let AMBER_I = '#d8b36a'
const DOT_LIVE = '●'
const DOT = '○'
const SHUT = '›'
const OPEN = '⌄'

const settingsRef = atom({ plugin: 'chat-clean', key: 'settings' } as const, F.PRESET.clean as Settings)
const liveRef = atom({ plugin: 'chat-clean', key: 'live' } as const, null as Live | null)
const tickRef = atom({ plugin: 'chat-clean', key: 'tick' } as const, 0)
// The work indicator: a braille spinner, one frame per 120 ms, written only while a turn runs;
// only the drawings that show it read it.
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const spinRef = atom({ plugin: 'chat-clean', key: 'spin' } as const, 0)
// Helpers launched together show in the line above the input (Claude Code draws its own
// 'background agents launched' block, and a mod cannot redraw it). The helpers launched since none was running form one
// batch: total, done, running, failed, time, then one line per kind. JSON, '' when no helper runs.
const crewRef = atom({ plugin: 'chat-clean', key: 'crew' } as const, '')
type Crew = { since: number; members: { id: string; kind: string; state: 'done' | 'running' | 'failed' }[] }
let crewIds: string[] = []
// a helper's kind, kept: a finished helper can leave the list, and its row then still names its kind
const crewKind = new Map<string, string>()
let crewSince = 0
// The background runs, never a helper: an entry the helper list knows (by id or description)
// is a helper that the turn-end list or an older build recorded (owner, 6 Oct: 'Test running'
// for 9 h while nothing ran).
async function liveBg($: EngineInterface) {
  const bg = (await read($, bgRef)) ?? []
  if (!bg.length) return bg
  const agents = await $.agent.list().catch(() => [])
  const known = new Set(agents.flatMap(a => [a.id, a.description, a.teammateId].filter(Boolean) as string[]))
  return bg.filter(b => !known.has(b.id) && !known.has(b.words))
}
async function readCrew($: EngineInterface): Promise<string> {
  const list = (await $.agent.list()).filter(a => a.parentId === undefined && a.teammateId === undefined)
  const busy = (st: string) => st === 'running' || st === 'pending' || st === 'waiting'
  if (!list.some(a => busy(a.status))) {
    crewIds = []
    return ''
  }
  if (crewIds.length === 0) crewSince = await $.clock.now()
  for (const a of list) if (busy(a.status) && !crewIds.includes(a.id)) crewIds.push(a.id)
  for (const a of list) if (a.type) crewKind.set(a.id, a.type)
  const byId = new Map(list.map(a => [a.id, a]))
  const crew: Crew = {
    since: crewSince,
    members: crewIds.map(id => {
      const a = byId.get(id)
      const st = a?.status ?? 'completed'
      return { id, kind: (a?.type ?? crewKind.get(id) ?? 'helper').replace(/^general-purpose$/, 'general'), state: busy(st) ? 'running' : st === 'failed' || st === 'killed' ? 'failed' : 'done' }
    }),
  }
  return JSON.stringify(crew)
}
const sweepRef = atom({ plugin: 'chat-clean', key: 'sweep' } as const, 0)
// Background runs of the main conversation, by tool_use id, until their notification arrives.
// While one runs after the turn, a line above the input says so and you can keep typing.
const bgRef = atom({ plugin: 'chat-clean', key: 'bg' } as const, [] as { id: string; words: string; at: number }[])
const TEST_WORDS = /\b(test|tests|suite|spec|specs|e2e|verify|check)\b/i
const helpersRef = atom({ plugin: 'chat-clean', key: 'helpers' } as const, 0)
const cursorRef = atom({ plugin: 'chat-clean', key: 'cursor' } as const, null as string | null)
const turnNowRef = atom({ plugin: 'chat-clean', key: 'turnNow' } as const, null as string | null)
const burstOpenRef = atom({ plugin: 'chat-clean', key: 'burstOpen' } as const, null as string | null)
const helperIdsRef = atom({ plugin: 'chat-clean', key: 'helperIds' } as const, [] as string[])
const callRunRef = { plugin: 'chat-clean', key: 'callRun' } as const
const runRef = { plugin: 'chat-clean', key: 'run' } as const
const turnRef = { plugin: 'chat-clean', key: 'turn' } as const
const openRef = { plugin: 'chat-clean', key: 'open' } as const
const helperRef = { plugin: 'chat-clean', key: 'helper' } as const
const agentCallRef = { plugin: 'chat-clean', key: 'agentCall' } as const
const peerBurstRef = { plugin: 'chat-clean', key: 'peerBurst' } as const
const burstRef = { plugin: 'chat-clean', key: 'burst' } as const

type El = (p: Record<string, unknown>) => RenderNode
type Els = { Box: El; Text: El; Button: El; Markdown: El }
// A quiet name in a 5-column margin: 'you' in a cool ink beside your words, 'claude' in a warm
// ink beside the reply (a Markdown element takes no colour, so the reply keeps the terminal's ink).
const NAME_W = 7
let YOU_INK = '#9fb4c8'
let CLAUDE_INK = '#e3c4a2'
// The time each of your messages was stored, by its uuid (the UserMessage requestId), drawn at
// the right edge. A message from before this session has no time: none drawn.
const promptAt = new Map<string, number>()
// helper messages by stored message uuid, parsed from the raw text at append (the row's text has lost the envelope)
const teamAt = new Map<string, F.Frame[]>()
function hhmm(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
type Site = { surface: string; requestId: string; viewport?: { columns: number; isFullscreen?: boolean } }

async function settingsOf($: EngineInterface): Promise<Settings> {
  return { ...F.PRESET.clean, ...((await read($, settingsRef)) ?? {}) }
}
async function setSettings($: EngineInterface, s: Settings) {
  await update($, settingsRef, () => s)
  await $.store.set('settings', s)
}
async function get<T>($: EngineInterface, p: Promise<{ value: T | undefined }>): Promise<T | undefined> {
  return (await p).value
}
// The text column's indent: the terminal draws a 'you' / 'claude' name column, the desktop app
// draws its own bubbles and no name column, so there the rows start at the left edge. Set at
// each row's drawing, read by the row helpers.
let PAD = NAME_W
function els($: EngineInterface, e: Site): Els {
  PAD = e.surface === 'desktop' ? 0 : NAME_W
  return $.ui.resolve(e as never) as unknown as Els
}
function roomOf(e: Site, less: number) {
  return Math.max(16, (e.viewport?.columns ?? 100) - less)
}
const hidden = (s: Settings, k: Kind) => s.hide.includes(k)
const isSearch = (tool: string) => tool === 'WebSearch' || tool === 'WebFetch'

// Debug trail for measuring the real screen: CHAT_CLEAN_DEBUG=<file>. Off costs one env read.
const trail: string[] = []
async function note($: EngineInterface, line: string) {
  try {
    const path = await $.env.get('CHAT_CLEAN_DEBUG')
    if (path === undefined || path === '') return
    trail.push(`${new Date(await $.clock.now()).toISOString()} ${line}`)
    if (trail.length > 600) trail.splice(0, trail.length - 600)
    await $.fs.write(path, trail.join('\n') + '\n')
  } catch {
    // a trail that cannot be kept never costs the row
  }
}

// ctrl+o: the detailed transcript draws message rows and groups with isExpanded, but a standalone
// tool row carries no such prop and keeps its cached drawing. The first expanded group seen flips
// this flag and asks every row to draw again, so hidden rows draw whole there; the first folded
// group seen flips it back.
let expandedView = false
function seeView($: EngineInterface, isExpanded: boolean) {
  if (isExpanded === expandedView) return
  expandedView = isExpanded
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // the rows draw again on their next change
  }
}

// A row that draws nothing: a box of no rows.
function nothing(Box: El) {
  return <Box display="none" />
}

// The chevron: a Button where the surface reports clicks (the fullscreen terminal, a desktop),
// plain text elsewhere, where a click never reaches a mod (the main screen has no mouse mode).
function chevron(e: Site, x: Els, key: string, isOpen: boolean, onPress: () => unknown) {
  const clickable = e.surface !== 'terminal' || e.viewport?.isFullscreen === true
  return clickable ? <x.Button key={key} plain dimColor label={isOpen ? OPEN : SHUT} onPress={onPress} /> : <x.Text dimColor>{SHUT}</x.Text>
}

// The desktop band (the desktop app runs no status line): one row with the usage pill (5-hour and
// weekly limits used), and a second row, only while something runs, with one pill per running
// helper, background job and test. The desktop lays text out wider than the engine counts, so the
// pills stay short and only the work pills may grow.
// Light mode: // The band's tints follow the theme row of /config: light themes get pale tints and darker inks.
const DARK = { empty: '#3a3a3e', g0: '#e9fff0', g1: '#bfe8c8', g2: '#9ed2a8', g3: '#5f9e6c', t0: '#f0fff6', t1: '#bfeadc', orgBg: '#26262a', orgFg: '#a9a7a0', boardBg: '#1d2e2a', boardFg: '#86d0bd', usageBg: '#24242a', green: '#8fd19e', violet: '#b9acec', helperBg: '#29243d', testBg: '#3a2620', testFg: '#e39a7c' }
const LIGHT = { empty: '#d9d9de', g0: '#0f5132', g1: '#2f7d55', g2: '#4f9a72', g3: '#6fb08c', t0: '#0b4f45', t1: '#1f7a6a', orgBg: '#ececef', orgFg: '#6b6b73', boardBg: '#e3f3ee', boardFg: '#1f7a6a', usageBg: '#ececf2', green: '#2f8a4a', violet: '#6a54c4', helperBg: '#ece8fa', testBg: '#fbe9e2', testFg: '#b5502e' }
let themeAt = 0
let themeLight = false
let osLight: boolean | null = null
// set once this session draws the desktop band: its clock then keeps the desktop's inks too
let onDesktop = false
async function palette($: EngineInterface, desktop = false) {
  const now = await $.clock.now()
  if (now - themeAt > 30000) {
    themeAt = now
    try {
      const row = (await $.config.list()).find(r => r.key === 'theme') as { value?: unknown } | undefined
      themeLight = /light/i.test(String(row?.value ?? ''))
    } catch {
      // keep the last answer
    }
    // owner, 6 Oct (a light desktop app with dark pills): the desktop app follows the system
    // appearance, not Claude Code's /config theme. On macOS, AppleInterfaceStyle reads "Dark"
    // in dark mode and is absent in light mode.
    try {
      const r = await $.process.run(['/usr/bin/defaults', 'read', '-g', 'AppleInterfaceStyle'])
      osLight = !/dark/i.test(String(r.stdout ?? ''))
    } catch {
      osLight = null
    }
  }
  const L = desktop && osLight !== null ? osLight : themeLight
  YOU_INK = L ? '#2f4f6f' : '#9fb4c8'
  CLAUDE_INK = L ? '#8a4a1f' : '#e3c4a2'
  PEER = L ? '#5b3fb5' : '#a78bfa'
  CHIP = L ? '#e4e6eb' : '#3b3b3b'
  GREEN_I = L ? '#1f7a4a' : '#7fbf8f'
  VIOLET_I = L ? '#5b3fb5' : '#b9acec'
  RED_I = L ? '#b42318' : '#e06c6c'
  AMBER_I = L ? '#8a5a00' : '#d8b36a'
  return L ? LIGHT : DARK
}
let accountCache = { at: 0, email: '' }
async function accountEmail($: EngineInterface, home: string) {
  const now = await $.clock.now()
  if (now - accountCache.at < 60000) return accountCache.email
  accountCache.at = now
  try {
    const base = (await $.env.get('CLAUDE_CONFIG_DIR')) || home
    const j = JSON.parse(String(await $.fs.read(`${base}/.claude.json`))) as { oauthAccount?: { emailAddress?: string } }
    accountCache.email = (j.oauthAccount?.emailAddress ?? '').trim()
  } catch {
    // keep the last answer
  }
  return accountCache.email
}
async function deskStatus($: EngineInterface, e: Site) {
  onDesktop = true
  const P = await palette($, true)
  const x = els($, e)
  const tick = (await read($, tickRef)) ?? 0
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const helpers = (await $.agent.list()).filter(a => a.status === 'running')
  const bg = await liveBg($)
  const tests = bg.filter(b => TEST_WORDS.test(b.words))
  const jobs = bg.filter(b => !TEST_WORDS.test(b.words))
  const lim = (k: string) => usage.rateLimits.find(r => r.kind === k)
  const h5 = lim('five_hour')
  const wk = lim('seven_day')
  const { Box, Text, Svg } = x as unknown as { Box: El; Text: El; Svg: El }
  const icon = (name: string, color: string) => <Svg source={F.iconSvg(name, color)} alt={name} width={14} height={14} />
  // A pill: a tinted box, a small icon or mark, and its words as one Text line of nested spans,
  // so a pill stays one line.
  const pill = (key: string, tint: string, kids: unknown[], grow = 0) => {
    const [first, ...rest] = kids.filter(Boolean)
    const spaced = rest.flatMap((k, i) => (i ? [<Text key={`sp${i}`}> </Text>, k] : [k]))
    return (
      <Box key={key} flexDirection="row" gap={1} alignItems="center" backgroundColor={tint} paddingX={1} flexShrink={0} flexGrow={grow} minWidth={0}>
        {first as never}
        <Text wrap="truncate-end">{spaced as never}</Text>
      </Box>
    )
  }
  const usagePill =
    h5 || wk ? (
      <Box key="usage" flexDirection="row" gap={1} alignItems="center" backgroundColor={P.usageBg} paddingX={1} flexShrink={0}>
        {h5 ? icon('clock', P.green) : null}
        {h5 ? <Text color={P.green} bold>{`${Math.round(h5.percentUsed)}%`}</Text> : null}
        {h5 ? <Text dimColor>5h</Text> : null}
        {h5 && wk ? <Text dimColor>·</Text> : null}
        {wk ? icon('cal', P.violet) : null}
        {wk ? <Text color={P.violet} bold>{`${Math.round(wk.percentUsed)}%`}</Text> : null}
        {wk ? <Text dimColor>week</Text> : null}
      </Box>
    ) : null
  const spinMark = ['◐', '◓', '◑', '◒'][Math.floor(tick) % 4]
  const workPills = [
    ...helpers.map((h, i) => pill(`h${i}`, P.helperBg, [<Text key="s" color={P.violet}>{spinMark}</Text>, <Text key="k" color={P.violet} bold>Helper</Text>, <Text key="w">{F.fit(h.description, 28)}</Text>], 1)),
    ...jobs.map((j, i) => pill(`j${i}`, P.helperBg, [<Text key="s" color={P.violet}>{spinMark}</Text>, <Text key="k" color={P.violet} bold>Job</Text>, <Text key="w">{F.fit(j.words, 28)}</Text>, <Text key="e" dimColor>{F.elapsed(now - j.at)}</Text>], 1)),
    ...tests.map((t, i) => pill(`t${i}`, P.testBg, [icon('flask', P.testFg), <Text key="k" color={P.testFg} bold>Test</Text>, <Text key="w">{F.fit(t.words, 28)}</Text>, <Text key="e" dimColor>{F.elapsed(now - t.at)}</Text>], 1)),
  ]
  if (!usagePill && workPills.length === 0) return null
  return (
    <Box flexDirection="column" gap={1}>
      {usagePill ? (
        <Box key="main" flexDirection="row" justifyContent="flex-end" alignItems="center" width="100%">
          {usagePill}
        </Box>
      ) : null}
      {workPills.length ? (
        <Box key="work" flexDirection="row" gap={1} flexWrap="nowrap" alignItems="center" overflow="hidden">
          {workPills as never}
        </Box>
      ) : null}
    </Box>
  )
}

// One quiet line: a dot, the words cut at a word, optional chips, optional chevron.
function line(x: Els, glyph: { live: boolean; text?: string; color?: string }, words: string, room: number, tail?: unknown, chips?: string[]) {
  const chipText = (chips ?? []).filter(Boolean)
  return (
    <x.Box flexDirection="row" gap={1} paddingLeft={PAD}>
      <x.Text color={glyph.color ?? (glyph.live ? ACCENT : undefined)} dimColor={!glyph.live && glyph.color === undefined}>
        {glyph.text ?? (glyph.live ? DOT_LIVE : DOT)}
      </x.Text>
      <x.Text dimColor wrap="truncate-end">
        {F.fit(words, room)}
      </x.Text>
      {chipText.length > 0 ? <x.Text dimColor>{`· ${chipText.join(' · ')}`}</x.Text> : null}
      {tail ?? null}
    </x.Box>
  )
}

// A call's own line; its chevron opens its output (the result, never a row of its own).
async function callLine($: EngineInterface, e: Site, x: Els, s: Settings, c: Call) {
  const isOpen = (await get($, $.state.get({ ...openRef, id: c.id }))) === true
  const words = c.refused ? `${c.words} · refused by a hook` : c.done ? c.past : c.words
  const chips = s.style === 'line' ? [] : [c.errored && !c.refused ? 'failed' : '', c.lines ? `+${c.lines} lines` : '']
  const canOpen = s.style !== 'line' && (c.out ?? '') !== ''
  const toggle = () => update($, { ...openRef, id: c.id } as never, (v: unknown) => !(v === true))
  return (
    <x.Box key={`call-${c.id}`} flexDirection="column">
      {line(x, { live: !c.done }, words, roomOf(e, 20), canOpen ? chevron(e, x, `out-${c.id}`, isOpen, toggle) : null, chips)}
      {isOpen && canOpen ? (
        <x.Box paddingLeft={2} flexDirection="column">
          {(c.out ?? '')
            .split('\n')
            .slice(0, 12)
            .map((l, i) => (
              <x.Text key={`o-${i}`} dimColor wrap="truncate-end">
                {l === '' ? ' ' : l}
              </x.Text>
            ))}
        </x.Box>
      ) : null}
    </x.Box>
  )
}

// A run's one line: the call in flight while one runs, else what it did: one call's own words,
// several as counts ("Ran 3 shell commands · read 1 file"). expanded lists its calls under it.
async function runLine($: EngineInterface, e: Site, x: Els, s: Settings, runId: string, run: Run, namesLive: boolean) {
  const isOpen = (await get($, $.state.get({ ...openRef, id: runId }))) === true
  const calls = run.calls.filter(c => !hidden(s, isSearch(c.tool) ? 'search' : 'tool'))
  if (calls.length === 0) return nothing(x.Box)
  const live = [...calls].reverse().find(c => !c.done)
  const only = calls.length === 1 ? calls[0]! : undefined
  const refused = calls.filter(c => c.refused).length
  const ran = calls.filter(c => !c.refused)
  const refusedWords = `${refused} step${refused === 1 ? '' : 's'} refused by a hook`
  const words =
    live && namesLive ? live.words : ran.length === 0 ? refusedWords : ran.length === 1 && !(ran[0]!.done === false) && calls.length === 1 ? ran[0]!.past : only ? (only.done ? only.past : only.words) : F.runCounts(ran)
  const failed = calls.filter(c => c.errored && !c.refused).length
  const lines = calls.reduce((n, c) => n + (c.lines ?? 0), 0)
  const chips = s.style === 'line' || (live && namesLive) ? [] : [refused > 0 && ran.length > 0 ? refusedWords : '', failed > 0 ? `${failed} failed` : '', !only && lines > 0 ? `+${lines} lines` : only?.lines ? `+${only.lines} lines` : '']
  const showCalls = s.style === 'expanded' || (s.style === 'subtle' && isOpen)
  const toggle = () => update($, { ...openRef, id: runId } as never, (v: unknown) => !(v === true))
  const canOpen = s.style === 'subtle' && (calls.length > 1 || (only?.out ?? '') !== '')
  // a run of one call opens straight to its output
  return (
    <x.Box flexDirection="column">
      {line(x, { live: live !== undefined && namesLive }, words, roomOf(e, 24), canOpen ? chevron(e, x, `open-${runId}`, isOpen, toggle) : null, chips)}
      {showCalls ? (
        <x.Box paddingLeft={2} flexDirection="column">
          {await Promise.all(calls.map(c => callLine($, e, x, s, c)))}
        </x.Box>
      ) : null}
    </x.Box>
  )
}

// The turn's one line: "○ 4 steps this turn ›".
function turnLine(e: Site, x: Els, $: EngineInterface, turnId: string, t: Turn, isOpen: boolean) {
  const toggle = () => update($, { ...openRef, id: `turn-${turnId}` } as never, (v: unknown) => !(v === true))
  return line(x, { live: false }, F.stepsLine(t.done), roomOf(e, 12), chevron(e, x, `turn-${turnId}`, isOpen, toggle))
}

// A helper's row: never folded: "● name · dispatched · running · 12s", "○ name · finished · 41s";
// its chevron opens the helpers pane.
async function agentRow($: EngineInterface, e: Site, x: Els, c: Call) {
  const hp = await get($, $.state.get({ ...helperRef, id: c.id }))
  const now = await $.clock.now()
  await read($, tickRef)
  const running = hp ? hp.status === 'running' : !c.done
  const name = hp?.name ?? c.words
  const status = running ? (c.done ? 'running' : 'dispatched · running') : hp?.status === 'failed' ? 'failed' : hp?.status === 'stopped' ? 'stopped' : 'finished'
  const took = hp ? F.elapsed((hp.endedAt ?? now) - hp.startedAt) : ''
  const open = () => $.ui.open({ id: LANES, title: 'Helpers', focus: true, closeOnEscape: true })
  const words = [name, status, took].filter(Boolean).join(' · ')
  return line(x, { live: running }, words, roomOf(e, 12), chevron(e, x, `lane-${c.id}`, false, open))
}

// An answered question: one line per question, "? question → answer", in the text column; the
// chevron opens the full question. Unanswered: "○ Asked you: <question>".
async function questionRow($: EngineInterface, e: Site, x: Els, c: Call) {
  const isOpen = (await get($, $.state.get({ ...openRef, id: c.id }))) === true
  const toggle = () => update($, { ...openRef, id: c.id } as never, (v: unknown) => !(v === true))
  const q = c.question ?? 'a question'
  if (c.done && c.pairs && c.pairs.length && !isOpen) {
    const room = roomOf(e, NAME_W + 6)
    return (
      <x.Box flexDirection="column">
        {c.pairs.map((p, i) => {
          const qRoom = Math.max(12, Math.min(p.q.length, Math.floor(room * 0.55)))
          return (
            <x.Box key={`${c.id}-${i}`} flexDirection="row" paddingLeft={PAD}>
              <x.Text color={ACCENT}>? </x.Text>
              <x.Text dimColor>{F.fit(p.q, qRoom)}</x.Text>
              <x.Text dimColor>{' → '}</x.Text>
              <x.Text wrap="truncate-end">{F.fit(p.a, Math.max(10, room - qRoom - 3))}</x.Text>
              {i === 0 ? <x.Text> </x.Text> : null}
              {i === 0 ? chevron(e, x, `q-${c.id}`, isOpen, toggle) : null}
            </x.Box>
          )
        })}
      </x.Box>
    ) as never
  }
  return (
    <x.Box flexDirection="column">
      {line(x, { live: !c.done }, `Asked you: ${isOpen ? q : F.fit(q, roomOf(e, 20))}`, isOpen ? 4000 : roomOf(e, 8), chevron(e, x, `q-${c.id}`, isOpen, toggle))}
      {c.answer ? (
        <x.Box flexDirection="row" gap={1} paddingLeft={2}>
          <x.Text dimColor>You picked</x.Text>
          <x.Text backgroundColor={CHIP}>{` ${F.fit(c.answer, roomOf(e, 20))} `}</x.Text>
        </x.Box>
      ) : c.done ? (
        <x.Box paddingLeft={2}>
          <x.Text dimColor>No answer</x.Text>
        </x.Box>
      ) : null}
    </x.Box>
  )
}

/**
 * What one call's site draws (ToolUse row, or one call of a ToolGroup), by the settings.
 * Returns null when the call is not this mod's to draw (raw mode, a call no event recorded).
 */
async function drawCall($: EngineInterface, e: Site, x: Els, s: Settings, id: string): Promise<unknown | null | 'none'> {
  const runId = await get($, $.state.get({ ...callRunRef, id }))
  if (runId === undefined) return null
  const run = await get($, $.state.get({ ...runRef, id: runId }))
  const c = run?.calls.find(k => k.id === id)
  if (!run || !c) return null
  if (c.refused && F.standsAlone(c.tool)) {
    // fall through: a refused helper or question is a plain step
  } else if (F.isAgentTool(c.tool)) return hidden(s, 'agent') ? 'none' : agentRow($, e, x, c)
  else if (c.tool === 'AskUserQuestion') return hidden(s, 'question') ? 'none' : questionRow($, e, x, c)
  if (hidden(s, isSearch(c.tool) ? 'search' : 'tool')) return 'none'
  const t = await get($, $.state.get({ ...turnRef, id: c.turnId }))
  const turnOpen = (await get($, $.state.get({ ...openRef, id: `turn-${c.turnId}` }))) === true
  const live = await read($, liveRef)
  const firstOfTurn = t?.first === id
  const r = { firstOfTurn, firstOfRun: runId === id, live: !c.done, spent: !(t?.open ?? false) }
  const folded = F.verdict(s, { ...r, turnOpened: false })
  const body = async (v: F.Verdict) => (v === 'run' ? runLine($, e, x, s, runId, run, !s.group || live === null) : v === 'call' ? callLine($, e, x, s, c) : null)
  if (folded === 'turn') {
    if (!t || t.done === 0) return turnOpen ? body(F.verdict(s, { ...r, turnOpened: true })) : 'none'
    const opened = turnOpen ? await body(F.verdict(s, { ...r, turnOpened: true })) : null
    return (
      <x.Box flexDirection="column">
        {turnLine(e, x, $, c.turnId, t, turnOpen)}
        {opened ? <x.Box paddingLeft={2}>{opened as never}</x.Box> : null}
      </x.Box>
    )
  }
  if (folded === 'hide' && turnOpen) {
    const v = F.verdict(s, { ...r, turnOpened: true })
    const b = await body(v)
    return b ? <x.Box paddingLeft={2}>{b as never}</x.Box> : 'none'
  }
  const b = await body(folded)
  return b ?? 'none'
}

// A resumed conversation: rebuild turns and runs from the transcript by the rules tool.call keeps.
async function rebuild($: EngineInterface) {
  const msgs = await $.session.messages()
  const runs = new Map<string, Run>()
  const turns = new Map<string, Turn>()
  const owner = new Map<string, string>()
  let cursor: string | null = null
  let turnId = 'h0'
  let n = 0
  for (const m of msgs) {
    if (m.role === 'user') {
      if (m.text.trim() !== '' && (m.toolResults ?? []).length === 0) {
        turnId = `h${++n}`
        cursor = null
      }
      continue
    }
    if (m.text.trim() !== '') cursor = null
    for (const u of m.toolUses) {
      const alone = F.standsAlone(u.tool)
      let runId = u.tool_use_id
      if (alone) cursor = null
      else {
        runId = cursor ?? u.tool_use_id
        cursor = runId
      }
      owner.set(u.tool_use_id, runId)
      const call: Call = {
        id: u.tool_use_id,
        tool: u.tool,
        turnId,
        words: F.stepWords(u.tool, u.input),
        past: F.pastWords(u.tool, u.input),
        startedAt: 0,
        done: u.text !== undefined,
        errored: u.isError === true,
        ...(u.tool === 'AskUserQuestion' ? { question: F.questionOf(u.input), answer: F.answerOf(u.result), pairs: F.pairsOf(u.result, u.input) } : {}),
      }
      const run = runs.get(runId) ?? { turnId, calls: [] }
      run.calls.push(call)
      runs.set(runId, run)
      const t = turns.get(turnId) ?? { first: null, calls: 0, done: 0, open: false, interrupted: false }
      if (!alone) {
        if (t.first === null) t.first = u.tool_use_id
        t.calls++
        if (call.done) t.done++
      }
      turns.set(turnId, t)
    }
  }
  const keep = [...owner].slice(-400)
  const keepRuns = new Set(keep.map(([, r]) => r))
  for (const [id, runId] of keep) {
    if ((await $.state.get({ ...callRunRef, id })).value !== undefined) continue
    await $.state.set({ ...callRunRef, id }, runId)
  }
  for (const runId of keepRuns) {
    if ((await $.state.get({ ...runRef, id: runId })).value !== undefined) continue
    const r = runs.get(runId)
    if (r) await $.state.set({ ...runRef, id: runId }, r)
  }
  for (const [id, t] of turns) {
    if ((await $.state.get({ ...turnRef, id })).value !== undefined) continue
    await $.state.set({ ...turnRef, id }, t)
  }
}

// The settings page: each setting, its value, a small picture of what it gives, and the command
// that changes it (a pane cannot count on having the keys mid-chat; the commands are immediate,
// so they work while Claude runs and with text in the box).
function settingsPage($: EngineInterface, x: Els, s: Settings, room: number) {
  const mode = F.modeOf(s)
  const row = (key: string, title: string, value: string, cmd: string, picture: string[], next: Settings) => (
    <x.Box key={`set-${key}`} flexDirection="column">
      <x.Box flexDirection="row" gap={1}>
        <x.Button key={`btn-${key}`} plain label={title} onPress={() => setSettings($, next)} />
        <x.Text bold color={ACCENT}>
          {value}
        </x.Text>
        <x.Text dimColor>{`· ${cmd}`}</x.Text>
      </x.Box>
      <x.Box flexDirection="column" paddingLeft={3}>
        {picture.map((p, i) => (
          <x.Text key={`pic-${key}-${i}`} dimColor wrap="truncate-end">
            {F.fit(p, room - 4)}
          </x.Text>
        ))}
      </x.Box>
    </x.Box>
  )
  const onOff = (b: boolean) => (b ? 'on' : 'off')
  return (
    <x.Box flexDirection="column" gap={1}>
      <x.Box flexDirection="row" gap={1}>
        <x.Text bold>Chat view</x.Text>
        <x.Text color={ACCENT}>{mode}</x.Text>
        <x.Text dimColor>· /feed clean · /feed normal · /feed raw · /feed close</x.Text>
      </x.Box>
      {row('group', 'Group a turn into one line', onOff(s.group), `/feed group ${s.group ? 'off' : 'on'}`, s.group ? ['you   fix the login bug', `${DOT} 6 steps this turn ${SHUT}`, 'claude Fixed: the token now refreshes.'] : ['you   fix the login bug', `${DOT} Ran 3 shell commands · read 2 files ${SHUT}`, `${DOT} Edited auth.ts`, 'claude Fixed: the token now refreshes.'], { ...s, group: !s.group, raw: false })}
      {row('clear', 'Clear after the turn', onOff(s.clear), `/feed clear ${s.clear ? 'off' : 'on'}`, s.clear ? ['a finished turn keeps only its one line (grouping on) or nothing (off)'] : ['a finished turn keeps its rows'], { ...s, clear: !s.clear, raw: false })}
      {row('keep', 'Keep every card', onOff(s.keep), `/feed keep ${s.keep ? 'off' : 'on'}`, s.keep ? ['finished turns stay drawn as they ran, whatever "clear" says'] : ['"clear after the turn" decides'], { ...s, keep: !s.keep, raw: false })}
      {row('style', 'Card style', s.style, `/feed style ${s.style === 'expanded' ? 'subtle' : s.style === 'subtle' ? 'line' : 'expanded'}`, s.style === 'expanded' ? [`${DOT} Ran 2 shell commands`, `  ${DOT} Ran the tests +12 lines`, `  ${DOT} Listed the files +4 lines`] : s.style === 'subtle' ? [`${DOT} Ran 2 shell commands +16 lines ${SHUT}`] : [`${DOT} Ran 2 shell commands`], { ...s, style: s.style === 'expanded' ? 'subtle' : s.style === 'subtle' ? 'line' : 'expanded', raw: false })}
      {row('commands', 'Commands in the chat', s.commands, `/feed commands ${s.commands === 'grouped' ? 'each' : 'grouped'}`, s.commands === 'grouped' ? [`${DOT} Ran 3 shell commands · read 1 file`] : [`${DOT} Ran the tests`, `${DOT} Listed the files`, `${DOT} Read app.py`], { ...s, commands: s.commands === 'grouped' ? 'each' : 'grouped', raw: false })}
      {row('after', 'After a command finishes', s.after, `/feed after ${s.after === 'clear' ? 'keep' : 'clear'}`, s.after === 'clear' ? ['a finished turn keeps the run line, not each command'] : ['each finished command keeps its own line'], { ...s, after: s.after === 'clear' ? 'keep' : 'clear', raw: false })}
      <x.Box flexDirection="column">
        <x.Text>Show</x.Text>
        <x.Box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={3}>
          {F.KINDS.map(k => (
            <x.Button key={`kind-${k}`} plain dimColor={s.hide.includes(k)} label={`${s.hide.includes(k) ? DOT : DOT_LIVE} ${k}`} onPress={() => setSettings($, { ...s, hide: s.hide.includes(k) ? s.hide.filter(other => other !== k) : [...s.hide, k] })} />
          ))}
        </x.Box>
        <x.Box paddingLeft={3}>
          <x.Text dimColor>/feed hide &lt;kind&gt; · /feed show &lt;kind&gt;</x.Text>
        </x.Box>
      </x.Box>
    </x.Box>
  )
}

// The helpers pane: each helper's own transcript, call by call, never folded.
async function lanePane($: EngineInterface, x: Els, room: number) {
  const ids = (await read($, helperIdsRef)) ?? []
  const now = await $.clock.now()
  await read($, tickRef)
  if (ids.length === 0) return <x.Text dimColor>No helper ran in this session.</x.Text>
  const blocks = []
  for (const id of ids.slice(-6).reverse()) {
    const hp = await get($, $.state.get({ ...helperRef, id }))
    if (!hp) continue
    const running = hp.status === 'running'
    const head = [hp.name, running ? 'working' : hp.status, F.elapsed((hp.endedAt ?? now) - hp.startedAt)].join(' · ')
    let calls: { words: string; done: boolean }[] = []
    if (hp.agentId) {
      try {
        const msgs = await $.session.messages({ agentId: hp.agentId })
        if (Array.isArray(msgs))
          calls = msgs.flatMap(m => m.toolUses.map(u => ({ words: u.text === undefined ? F.stepWords(u.tool, u.input) : F.pastWords(u.tool, u.input), done: u.text !== undefined })))
      } catch {
        // its transcript is not readable: the head line stands
      }
    }
    blocks.push(
      <x.Box key={`lane-${id}`} flexDirection="column">
        {line(x, { live: running }, head, room)}
        {running && hp.now ? (
          <x.Box paddingLeft={2}>
            <x.Text dimColor wrap="truncate-end">{`now: ${F.fit(hp.now, room - 8)}`}</x.Text>
          </x.Box>
        ) : null}
        <x.Box paddingLeft={2} flexDirection="column">
          {calls.slice(-12).map((c, i) => (
            <x.Box key={`lc-${i}`}>{line(x, { live: !c.done }, c.words, room - 4)}</x.Box>
          ))}
        </x.Box>
      </x.Box>,
    )
  }
  return (
    <x.Box flexDirection="column" gap={1}>
      {blocks}
    </x.Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('settings')
      if (saved && typeof saved === 'object') await update($, settingsRef, () => ({ ...F.PRESET.clean, ...(saved as Partial<Settings>) }))
      await $.command.register({ name: 'feed', description: 'Chat view: clean, normal, raw, or one setting', argumentHint: 'clean | normal | raw | <setting> <value>', immediate: true })
      await $.command.register({ name: 'helpers', description: "Show each helper's own work, call by call", immediate: true })
    } catch {
      // the defaults stand
    }
    try {
      await rebuild($)
    } catch {
      // a resumed conversation's old rows keep Claude Code's drawing
    }
    $.clock.every(120, async () => {
      if ((await read($, liveRef)) === null) return
      await update($, spinRef, n => ((n ?? 0) + 1) % SPIN.length)
    })
    $.clock.every(70, async () => {
      if ((await read($, liveRef)) === null && (await liveBg($)).length === 0) return
      await update($, sweepRef, n => ((n ?? 0) + 1) % 4000)
    })
    // the clocks and the helper count: one write a second, only while a turn or a helper runs
    $.clock.every(1000, async () => {
      try {
        const kept = await liveBg($)
        if (kept.length !== ((await read($, bgRef)) ?? []).length) await update($, bgRef, () => kept)
      } catch {
        // the list is pruned again next second
      }
      try {
        await palette($, onDesktop)
      } catch {
        // keep the last inks
      }
      try {
        const crew = await readCrew($)
        if (crew !== ((await read($, crewRef)) ?? '')) await update($, crewRef, () => crew)
        else if (crew) await update($, tickRef, n => (n ?? 0) + 1)
      } catch {
        // no helper line this second
      }
      const live = await read($, liveRef)
      const ids = (await read($, helperIdsRef)) ?? []
      let anyHelper = false
      for (const id of ids.slice(-6)) if ((await get($, $.state.get({ ...helperRef, id })))?.status === 'running') anyHelper = true
      if (live === null && !anyHelper) return
      await update($, tickRef, n => (n ?? 0) + 1)
      const running = (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending').length
      if (running !== (await read($, helpersRef))) await update($, helpersRef, () => running)
    })
    return next(e)
  })

  on('command.run', { command: 'feed' }, async ($, e) => {
    const cmd = F.parseFeed(e.args)
    const s = await settingsOf($)
    if (cmd.kind === 'bad') return { text: F.USAGE }
    if (cmd.kind === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Chat view settings closed.' }
    }
    if (cmd.kind === 'page') {
      await $.ui.open({ id: PANE, title: 'Chat view', focus: true, closeOnEscape: true })
      return { text: `Chat view: ${F.modeOf(s)}. Settings are open above the prompt; /feed close shuts them.` }
    }
    if (cmd.kind === 'preset') {
      await setSettings($, { ...F.PRESET[cmd.preset], hide: s.hide })
      return { text: `Chat view: ${cmd.preset}. ${F.PRESET_HELP[cmd.preset]}.` }
    }
    if (cmd.kind === 'set') {
      await setSettings($, { ...s, ...cmd.patch, raw: false })
      return { text: `Chat view: ${cmd.said}.` }
    }
    const hide = cmd.kind === 'hide' ? [...new Set([...s.hide, cmd.what])] : s.hide.filter(k => k !== cmd.what)
    await setSettings($, { ...s, hide, raw: false })
    return { text: `Chat view: ${cmd.what} ${cmd.kind === 'hide' ? 'hidden' : 'shown'}.` }
  })

  on('command.run', { command: 'helpers' }, async $ => {
    await $.ui.open({ id: LANES, title: 'Helpers', focus: true, closeOnEscape: true })
    return { text: 'Helpers open above the prompt.' }
  })

  // ---- the turn, its calls and its helpers ----

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, liveRef, () => ({ turnId: e.turnId, startedAt: now, steps: 0, label: '', tool: '', callAt: now }))
    await update($, cursorRef, () => null)
    await update($, turnNowRef, () => e.turnId)
    await $.state.set({ ...turnRef, id: e.turnId }, { first: null, calls: 0, done: 0, open: true, interrupted: false })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, liveRef, () => null)
      await update($, cursorRef, () => null)
      await update($, turnNowRef, () => null)
      await update($, { ...turnRef, id: e.turnId } as never, (t: Turn | undefined) => ({ ...(t ?? { first: null, calls: 0, done: 0 }), open: false, interrupted: e.isAborted }))
    } else {
      const callId = await get($, $.state.get({ ...agentCallRef, id: e.agentId }))
      if (callId !== undefined) {
        const now = await $.clock.now()
        const status = e.reason === 'error' ? 'failed' : e.isAborted ? 'stopped' : 'finished'
        await update($, { ...helperRef, id: callId } as never, (h: Helper | undefined) => (h ? { ...h, status, endedAt: now } : h) as Helper)
      }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.agentId !== undefined) {
        const now = await $.clock.now()
        const name = F.plain(e.description || e.name || e.subagentType) || 'helper'
        await $.state.set({ ...helperRef, id: e.tool_use_id }, { callId: e.tool_use_id, name, agentId: r.agentId, status: 'running', startedAt: now, endedAt: null, now: '', kind: e.subagentType || 'general-purpose' })
        await $.state.set({ ...agentCallRef, id: r.agentId }, e.tool_use_id)
        await update($, helperIdsRef, ids => [...(ids ?? []).filter(i => i !== e.tool_use_id), e.tool_use_id].slice(-40))
      }
    } catch {
      // the row still draws from the call
    }
    return r
  })

  // Every turn end hands the engine's own list of in-flight background work (shells, helpers,
  // monitors): it replaces what the mod held, so runs started before a reload show too.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    try {
      const tasks = (e as unknown as { background_tasks?: { id: string; type: string; status: string; description: string; command?: string }[] }).background_tasks
      if (Array.isArray(tasks)) {
        const now = await $.clock.now()
        const old = (await read($, bgRef)) ?? []
        // a task the helper list knows is a helper, whatever type the event gives it
        const agents = await $.agent.list().catch(() => [])
        const helperIds = new Set(agents.flatMap(a => [a.id, a.description, a.teammateId].filter(Boolean) as string[]))
        await update($, bgRef, () =>
          tasks
            // shells and monitors only: helpers (subagents, teammates) have their own line, and an idle
            // teammate stays 'running' for hours (owner, 6 Oct: 'Test running … while nothing is running')
            .filter(t => (t.status === 'running' || t.status === 'pending') && !/agent|teammate/i.test(String(t.type ?? '')) && !helperIds.has(t.id) && !helperIds.has(t.description))
            .map(t => ({ id: t.id, words: t.description || t.command || t.type, at: old.find(o => o.id === t.id || o.words === t.description)?.at ?? now })),
        )
      }
    } catch {
      // the list comes again at the next turn end
    }
    return r
  })

  // Claude's own text ends a run and takes over the live line; peers that arrive together fold.
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    try {
      const m = e.message
      if (m.type === 'user' && e.door === 'prompt' && !m.isMeta && e.uuid) promptAt.set(String(e.uuid), await $.clock.now())
      if (m.type === 'assistant') {
        for (const b of m.content as { type: string; id?: string; name?: string; input?: { run_in_background?: boolean; description?: string; command?: string } }[])
          if (b.type === 'tool_use' && b.name === 'Bash' && b.input?.run_in_background === true && b.id) {
            const words = String(b.input.description ?? b.input.command ?? '')
            const at = await $.clock.now()
            await update($, bgRef, l => [...(l ?? []).filter(x => x.id !== b.id), { id: b.id!, words, at }])
          }
      } else if (m.type === 'user') {
        const text = typeof m.content === 'string' ? m.content : (m.content as { type: string; text?: string }[]).map(b => (b.type === 'text' ? b.text ?? '' : '')).join('\n')
        if (e.uuid && text.includes('<teammate-message')) {
          const frames = F.framesOfRaw(text)
          if (frames.length) teamAt.set(String(e.uuid), frames)
        }
        const ids = [...text.matchAll(/<(?:tool-use-id|task-id)>([^<]+)<\/(?:tool-use-id|task-id)>/g)].map(x => x[1])
        if (ids.length) await update($, bgRef, l => (l ?? []).filter(x => !ids.includes(x.id)))
      }
      if (m.type === 'assistant' && e.door === 'response') {
        const hasText = m.content.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
        if (hasText) {
          await update($, cursorRef, () => null)
          await update($, liveRef, l => (l ? { ...l, label: 'Writing', tool: '' } : l))
          await update($, burstOpenRef, () => null)
        }
      } else if (m.type === 'user') {
        const kind = e.origin.kind
        if (kind === 'peer' || kind === 'peer-send-message') {
          const text = m.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
          const now = await $.clock.now()
          const burstId = (await read($, burstOpenRef)) ?? e.uuid
          await update($, burstOpenRef, () => burstId)
          await $.state.set({ ...peerBurstRef, id: e.uuid }, burstId)
          await update($, { ...burstRef, id: burstId } as never, (b: Burst | undefined) => ({ members: [...(b?.members ?? []), { uuid: e.uuid, name: F.senderOf(text) ?? 'another session', at: now }] }))
          await note($, `append peer uuid=${e.uuid} burst=${burstId}`)
        } else if (kind === 'composer' || kind === 'bridge') {
          await update($, burstOpenRef, () => null)
        }
      }
    } catch {
      // the rows draw on their own
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = e.tool_use_id
    if (e.agentId !== undefined) {
      // a helper's call: its pane's "now:" line
      try {
        const callId = await get($, $.state.get({ ...agentCallRef, id: e.agentId }))
        if (callId !== undefined) await update($, { ...helperRef, id: callId } as never, (h: Helper | undefined) => (h ? { ...h, now: F.stepWords(tool, e) } : h) as Helper)
      } catch {
        // the pane keeps its last line
      }
      return next(e)
    }
    try {
      const now = await $.clock.now()
      const turnId = (await read($, turnNowRef)) ?? 'none'
      const call: Call = {
        id,
        tool,
        turnId,
        words: F.stepWords(tool, e),
        past: F.pastWords(tool, e),
        startedAt: now,
        done: false,
        errored: false,
        ...(tool === 'AskUserQuestion' ? { question: F.questionOf(e) } : {}),
      }
      await update($, liveRef, l => (l ? { ...l, steps: l.steps + 1, label: call.words, tool, callAt: now } : l))
      // read-apply-write with ifVersion: calls made in parallel each land
      const alone = F.standsAlone(tool)
      const cur = await update($, cursorRef, c => (alone ? null : (c ?? id)))
      const runId = alone ? id : (cur ?? id)
      await $.state.set({ ...callRunRef, id }, runId)
      await update($, { ...runRef, id: runId } as never, (r: Run | undefined) => ({ turnId, calls: [...(r?.calls ?? []), call] }))
      if (!alone)
        await update($, { ...turnRef, id: turnId } as never, (t: Turn | undefined) => {
          const base = t ?? { first: null, calls: 0, done: 0, open: true, interrupted: false }
          return { ...base, first: base.first ?? id, calls: base.calls + 1 }
        })
    } catch {
      // bookkeeping lost for this call: its row falls back to the engine's
    }
    const r = await next(e)
    try {
      const runId = await get($, $.state.get({ ...callRunRef, id }))
      if (runId !== undefined) {
        const errored = (r as { isError?: boolean }).isError === true || typeof (r as { deny?: string }).deny === 'string'
        const result = (r as { result?: unknown }).result
        const o = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
        const out = typeof o.stdout === 'string' ? [o.stdout, typeof o.stderr === 'string' ? o.stderr : ''].filter(Boolean).join('\n').trimEnd() : ''
        const errText = errored ? (typeof r.text === 'string' ? r.text : typeof (r as { deny?: string }).deny === 'string' ? String((r as { deny: string }).deny) : '') : ''
        const refused = errored && F.isRefusal(errText)
        const body = out !== '' ? out : errText.trim()
        const lines = body === '' ? 0 : body.split('\n').length
        const answer = tool === 'AskUserQuestion' ? F.answerOf(result) : undefined
        const pairs = tool === 'AskUserQuestion' ? F.pairsOf(result, (e as { input?: unknown }).input ?? e) : undefined
        await update($, { ...runRef, id: runId } as never, (run: Run | undefined) => ({
          turnId: run?.turnId ?? 'none',
          calls: (run?.calls ?? []).map(c =>
            c.id === id ? { ...c, done: true, errored, ...(refused ? { refused } : {}), ...(lines > 0 ? { lines, out: body.slice(0, 2000) } : {}), ...(answer ? { answer } : {}), ...(pairs && pairs.length ? { pairs } : {}) } : c,
          ),
        }))
        const call = (await get($, $.state.get({ ...runRef, id: runId })))?.calls.find(c => c.id === id)
        if (call && refused && F.standsAlone(tool))
          // a refused helper or question is one more step of the turn, folded like any call
          await update($, { ...turnRef, id: call.turnId } as never, (t: Turn | undefined) => (t ? { ...t, first: t.first ?? id, calls: t.calls + 1, done: t.done + 1 } : t) as Turn)
        else if (call && !F.standsAlone(tool))
          await update($, { ...turnRef, id: call.turnId } as never, (t: Turn | undefined) => (t ? { ...t, done: t.done + 1 } : t) as Turn)
        if (F.isAgentTool(tool)) {
          // a foreground helper's call ends when the helper does; a background one keeps running
          const h = await get($, $.state.get({ ...helperRef, id }))
          const listed = h?.agentId ? (await $.agent.list()).find(a => a.id === h.agentId) : undefined
          if (h && h.status === 'running' && (listed === undefined || ['completed', 'failed', 'killed', 'idle'].includes(listed.status))) {
            const now = await $.clock.now()
            await $.state.set({ ...helperRef, id }, { ...h, status: listed?.status === 'failed' ? 'failed' : listed?.status === 'killed' ? 'stopped' : 'finished', endedAt: now })
          }
        }
      }
    } catch {
      // the row keeps reading as running until its run is drawn again
    }
    return r
  })

  // ---- drawing ----

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const s = await settingsOf($)
    await note($, `ToolUse ${e.surface} req=${e.requestId} tool=${e.props.tool} running=${e.props.isRunning} fs=${String(e.viewport?.isFullscreen)}`)
    if (s.raw || expandedView) return next(e)
    const x = els($, e)
    const drawn = await drawCall($, e, x, s, e.props.tool_use_id)
    if (drawn === 'none') return nothing(x.Box) as never
    if (drawn !== null) return drawn as never
    // not seen by tool.call yet: a call of the running turn about to start (hide), or history
    return (await read($, liveRef)) !== null ? (nothing(x.Box) as never) : next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    seeView($, e.props.isExpanded)
    const s = await settingsOf($)
    if (s.raw || e.props.isExpanded) return next(e)
    const x = els($, e)
    // A group of two or more helper launches is one live line with the total and the state
    // counts, then one line per helper kind below it.
    const helperIds = e.props.calls.map(c => c.tool_use_id).filter((id): id is string => id !== undefined)
    const hs: Helper[] = []
    for (const id of helperIds) {
      const h = await get($, $.state.get({ ...helperRef, id }))
      if (h) hs.push(h)
    }
    if (hs.length >= 2 && hs.length === helperIds.length) {
      await read($, tickRef)
      const now = await $.clock.now()
      const n = (st: Helper['status']) => hs.filter(h => h.status === st).length
      const done = n('finished')
      const running = n('running')
      const failed = n('failed') + n('stopped')
      const first = Math.min(...hs.map(h => h.startedAt))
      const last = running ? now : Math.max(...hs.map(h => h.endedAt ?? now))
      const live = running > 0
      const head = [`${hs.length} helpers`, done ? `${done} done` : '', running ? `${running} running` : '', failed ? `${failed} failed` : '', F.elapsed(last - first)].filter(Boolean)
      const kinds = new Map<string, Helper[]>()
      for (const h of hs) kinds.set(h.kind ?? 'general-purpose', [...(kinds.get(h.kind ?? 'general-purpose') ?? []), h])
      const isOpen = (await get($, $.state.get({ ...openRef, id: `batch-${helperIds[0]}` }))) === true
      const toggle = () => update($, { ...openRef, id: `batch-${helperIds[0]}` } as never, (v: unknown) => !(v === true))
      const kindRow = (kind: string, list: Helper[]) => {
        const kd = list.filter(h => h.status === 'finished').length
        const kf = list.filter(h => h.status === 'failed' || h.status === 'stopped').length
        const cells = list.map(h => (h.status === 'finished' ? '●' : h.status === 'running' ? '◐' : h.status === 'failed' || h.status === 'stopped' ? '✕' : '○')).join('')
        return (
          <x.Box key={`k-${kind}`} flexDirection="row" gap={1} paddingLeft={PAD + 2}>
            <x.Text dimColor>{F.fit(kind, 22)}</x.Text>
            <x.Text dimColor>{String(list.length)}</x.Text>
            <x.Text>
              {[...cells].map((ch, i) => (
                <x.Text key={`c${i}`} color={ch === '●' ? GREEN_I : ch === '◐' ? VIOLET_I : ch === '✕' ? RED_I : undefined} dimColor={ch === '○'}>{ch}</x.Text>
              ))}
            </x.Text>
            <x.Text dimColor>{`${kd}/${list.length}${kf ? ` · ${kf} failed` : ''}`}</x.Text>
          </x.Box>
        )
      }
      const names = isOpen
        ? hs.map(h => (
            <x.Box key={`n-${h.callId}`} paddingLeft={PAD + 4}>
              <x.Text dimColor>{`${h.status === 'finished' ? '●' : h.status === 'running' ? '◐' : h.status === 'failed' || h.status === 'stopped' ? '✕' : '○'} ${F.fit(h.name, 60)}`}</x.Text>
            </x.Box>
          ))
        : []
      return (
        <x.Box flexDirection="column">
          {line(x, { live, text: live ? SPIN[((await read($, spinRef)) ?? 0) % SPIN.length] : failed ? '✕' : '●', color: failed ? RED_I : live ? VIOLET_I : GREEN_I }, head.join(' · '), roomOf(e as Site, 12), chevron(e as Site, x, `batch-${helperIds[0]}`, isOpen, toggle))}
          {[...kinds.entries()].map(([k, l]) => kindRow(k, l))}
          {names as never}
        </x.Box>
      ) as never
    }
    const parts: unknown[] = []
    let known = false
    for (const c of e.props.calls) {
      if (c.tool_use_id === undefined) continue
      const d = await drawCall($, e, x, s, c.tool_use_id)
      if (d === null) continue
      known = true
      if (d !== 'none') parts.push(<x.Box key={`g-${c.tool_use_id}`}>{d as never}</x.Box>)
    }
    if (!known) return next(e)
    return (parts.length === 0 ? nothing(x.Box) : <x.Box flexDirection="column">{parts as never}</x.Box>) as never
  })

  // A result is never its own row: it rides on its call (the "+N lines" chip, the body one click away).
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const s = await settingsOf($)
    if (s.raw || expandedView) return next(e)
    const runId = await get($, $.state.get({ ...callRunRef, id: e.props.tool_use_id }))
    return runId === undefined ? next(e) : (nothing(els($, e).Box) as never)
  })

  // The run-in-background hint: the live line stands for the call (ctrl+b still works; only the hint text goes).
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const s = await settingsOf($)
    if (s.raw || expandedView) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // The turn-end timing line is not drawn: the live line already showed the time.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const s = await settingsOf($)
    if (s.raw || expandedView) return next(e)
    return nothing(els($, e).Box) as never
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const s = await settingsOf($)
    // never reads the view flag: an expanded tool group (an answered question card) set it and every
    // later reply would fall back to the default look
    if (s.raw) return next(e)
    if (hidden(s, 'said')) return nothing(els($, e).Box) as never
    const x = els($, e)
    const err = F.errorLine(e.props.text)
    // The desktop app draws its own you / Claude distinction, so there a reply keeps its own look.
    if (!err && e.surface === 'desktop') return next(e)
    if (err)
      return (
        <x.Box flexDirection="row" marginTop={1}>
          <x.Box width={NAME_W} flexShrink={0}>
            <x.Text color={err.guard ? PEER : err.act ? 'red' : AMBER_I}>!</x.Text>
          </x.Box>
          <x.Box flexGrow={1} flexShrink={1}>
            <x.Text>
              <x.Text>{err.words.split(' · ')[0]}</x.Text>
              <x.Text dimColor>{err.words.includes(' · ') ? ' · ' + err.words.split(' · ').slice(1).join(' · ') : ''}</x.Text>
            </x.Text>
          </x.Box>
        </x.Box>
      ) as never
    return (
      <x.Box flexDirection="row" marginTop={e.props.isFirstOfReply ? 1 : 0}>
        <x.Box width={NAME_W} flexShrink={0}>
          <x.Text color={CLAUDE_INK} dimColor>{e.props.isFirstOfReply ? 'claude' : ''}</x.Text>
        </x.Box>
        <x.Box flexGrow={1} flexShrink={1}>
          <x.Markdown text={e.props.text} />
        </x.Box>
      </x.Box>
    ) as never
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    // A message row's isExpanded is also true for a short message that fits its label's cap,
    // so it never sets the view flag: it would flip every later reply back to the default look.
    const s = await settingsOf($)
    await note($, `UserMessage ${e.surface} req=${e.requestId} kind=${e.props.origin.kind} expanded=${e.props.isExpanded} from=${e.props.from?.name ?? ''}`)
    if (s.raw || e.props.isExpanded) return next(e)
    const x = els($, e)
    const kind = e.props.origin.kind
    const from = e.props.from?.name
    // helper messages (a teammate block, or a helper's status JSON): one header line per message,
    // then its first paragraph as formatted text; ctrl+o keeps the whole of it
    const frames = kind === 'composer' || kind === 'bridge' || kind === 'sdk' || kind === 'task-notification' ? [] : teamAt.get(String(e.requestId)) ?? F.framesOfView(e.props.text)
    if (frames.length) {
      if (hidden(s, 'peer')) return nothing(x.Box) as never
      const room = roomOf(e, 14)
      return (
        <x.Box flexDirection="column" marginTop={1}>
          {frames.map((f, i) => {
            const card = F.reportCard(f.body)
            const { lead, more } = card ? { lead: '', more: 0 } : F.leadOf(f.body)
            const head = [f.from ?? from ?? 'helper', f.state, f.at !== undefined ? hhmm(f.at) : '', f.summary].filter(Boolean).join(' · ')
            return (
              <x.Box key={`team-${i}`} flexDirection="column" marginTop={i ? 1 : 0}>
                {line(x, { live: false, text: '⇄', color: PEER }, head, room)}
                {card ? (
                  <x.Box paddingLeft={PAD + 2} flexDirection="column">
                    <x.Box flexDirection="row" gap={1}>
                      {card.status ? <x.Text color={card.status.tone === 'ok' ? GREEN_I : card.status.tone === 'bad' ? RED_I : AMBER_I} bold>{`${card.status.tone === 'ok' ? '✓' : card.status.tone === 'bad' ? '✕' : '●'} ${card.status.text}`}</x.Text> : null}
                      {card.sub ? <x.Text>{card.sub}</x.Text> : null}
                    </x.Box>
                    {card.target ? (
                      <x.Box flexDirection="row" gap={1}>
                        <x.Text dimColor>{'target '}</x.Text>
                        <x.Text wrap="truncate-end">{card.target}</x.Text>
                      </x.Box>
                    ) : null}
                    {card.scores.map(sc => (
                      <x.Box key={`sc-${sc.label}`} flexDirection="row" gap={1}>
                        <x.Text dimColor>{F.fit(sc.label, 12).padEnd(7)}</x.Text>
                        <x.Text>
                          {sc.marks.slice(0, 24).map((m, k) => (
                            <x.Text key={`m${k}`} color={m === 'ok' ? GREEN_I : m === 'bad' ? RED_I : AMBER_I}>●</x.Text>
                          ))}
                        </x.Text>
                        <x.Text>{`${sc.pass} of ${sc.marks.length} pass`}</x.Text>
                      </x.Box>
                    ))}
                    {card.file ? (
                      <x.Box flexDirection="row" gap={1}>
                        <x.Text dimColor>{'report '}</x.Text>
                        <x.Text color={YOU_INK}>{card.file}</x.Text>
                      </x.Box>
                    ) : null}
                    <x.Text dimColor>ctrl+o shows the whole report</x.Text>
                  </x.Box>
                ) : lead ? (
                  <x.Box paddingLeft={PAD + 2} flexDirection="column">
                    <x.Markdown text={lead} />
                    {more ? <x.Text dimColor>{`+${more} more line${more > 1 ? 's' : ''} · ctrl+o shows all`}</x.Text> : null}
                  </x.Box>
                ) : null}
              </x.Box>
            )
          })}
        </x.Box>
      ) as never
    }
    const isPerson = kind === 'composer' || kind === 'bridge' || kind === 'sdk' || kind === 'scheduled-trigger' || (kind === 'unclassified' && from === undefined && !F.isHookText(e.props.text))
    if (isPerson) {
      if (hidden(s, 'you')) return nothing(x.Box) as never
      if (e.surface === 'desktop') return next(e)
      return (
        <x.Box flexDirection="row" marginTop={1}>
          <x.Box width={NAME_W} flexShrink={0}>
            <x.Text color={YOU_INK} dimColor>you</x.Text>
          </x.Box>
          <x.Box flexGrow={1} flexShrink={1}>
            {/^\/[\w:-]+/.test(e.props.text) ? (
              // a slash command: its name in your ink, its arguments dim
              <x.Text>
                <x.Text color={YOU_INK}>{e.props.text.match(/^\/[\w:-]+/)![0]}</x.Text>
                <x.Text dimColor>{e.props.text.replace(/^\/[\w:-]+/, '')}</x.Text>
              </x.Text>
            ) : (
              <x.Text color={YOU_INK}>{e.props.text}</x.Text>
            )}
          </x.Box>
          {promptAt.has(String(e.requestId)) ? (
            <x.Box flexShrink={0} paddingLeft={2}>
              <x.Text dimColor>{F.clock(promptAt.get(String(e.requestId))!)}</x.Text>
            </x.Box>
          ) : null}
        </x.Box>
      ) as never
    }
    const room = roomOf(e, 14)
    if (F.isHookText(e.props.text)) {
      // hook text that reaches a message row: one quiet line
      return line(x, { live: false }, F.hookLabel(e.props.text), room) as never
    }
    if (kind === 'task-notification') {
      const t = e.props.task
      let isHelper = true
      if (t?.toolUseId !== undefined) {
        const runId = await get($, $.state.get({ ...callRunRef, id: t.toolUseId }))
        const run = runId === undefined ? undefined : await get($, $.state.get({ ...runRef, id: runId }))
        const call = run?.calls.find(c => c.id === t.toolUseId)
        if (call) isHelper = F.isAgentTool(call.tool)
      }
      if (!isHelper) return (s.clear && !s.keep ? nothing(x.Box) : line(x, { live: false }, 'background task update', room)) as never
      if (hidden(s, 'helper')) return nothing(x.Box) as never
      const dur = t?.durationMs !== undefined ? ` · ${F.elapsed(t.durationMs)}` : ''
      return line(x, { live: false, text: '⇄', color: PEER }, `helper${dur} · ${F.headLine(e.props.text, room - 16)}`, room) as never
    }
    if (hidden(s, 'peer')) return nothing(x.Box) as never
    // a burst: two or more messages that arrived together fold to one line on the first
    const burstId = await get($, $.state.get({ ...peerBurstRef, id: e.requestId }))
    const burst = burstId === undefined ? undefined : await get($, $.state.get({ ...burstRef, id: burstId }))
    if (burst && burst.members.length > 1) {
      const isOpen = (await get($, $.state.get({ ...openRef, id: `burst-${burstId}` }))) === true
      if (burst.members[0]!.uuid === e.requestId) {
        const toggle = () => update($, { ...openRef, id: `burst-${burstId}` } as never, (v: unknown) => !(v === true))
        const fold = line(x, { live: false, text: '⇄', color: PEER }, F.peerFold(burst.members.map(m => m.name), burst.members[burst.members.length - 1]!.at), room, chevron(e, x, `burst-${burstId}`, isOpen, toggle))
        if (!isOpen) return fold as never
        return (
          <x.Box flexDirection="column">
            {fold}
            <x.Box paddingLeft={2}>{line(x, { live: false, text: '⇄', color: PEER }, `${from ?? 'another session'} · ${F.headLine(e.props.text, room - 20)}`, room)}</x.Box>
          </x.Box>
        ) as never
      }
      if (!isOpen) return nothing(x.Box) as never
      return (<x.Box paddingLeft={2}>{line(x, { live: false, text: '⇄', color: PEER }, `${from ?? 'another session'} · ${F.headLine(e.props.text, room - 20)}`, room)}</x.Box>) as never
    }
    return line(x, { live: false, text: '⇄', color: PEER }, `${from ?? 'another session'} · ${F.headLine(e.props.text, room - 20)}`, room) as never
  })

  // The working line: the live step sits in the text column under the last row: spinner, words, time.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const s = await settingsOf($)
    if (s.raw) return next(e)
    const live = await read($, liveRef)
    if (live === null) return nothing(els($, e).Box) as never
    try {
      const x = els($, e)
      await read($, tickRef)
      const helpers = (await read($, helpersRef)) ?? 0
      const now = await $.clock.now()
      const ownRow = F.standsAlone(live.tool) || live.tool === ''
      const words = F.liveLine(live, now, helpers, false, s.group && !(ownRow && live.label !== 'Writing'))
      const spin = SPIN[((await read($, spinRef)) ?? 0) % SPIN.length]
      return (
        <x.Box flexDirection="row" gap={1} paddingLeft={PAD}>
          <x.Text color={ACCENT}>{spin}</x.Text>
          <x.Text dimColor wrap="truncate-end">{F.fit(words, roomOf(e as Site, NAME_W + 4))}</x.Text>
        </x.Box>
      ) as never
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await settingsOf($)
    if (s.raw) return next(e)
    // The desktop app runs no status line command, so there this band carries usage and what runs.
    if (e.surface === 'desktop' && !e.props.hasSurvey) {
      try {
        const band = await deskStatus($, e as Site)
        return band === null ? next(e) : (band as never)
      } catch {
        return next(e)
      }
    }
    const crewJson = (await read($, crewRef)) ?? ''
    if (crewJson) {
      try {
        const crew = JSON.parse(crewJson) as Crew
        const x = els($, e)
        await read($, tickRef)
        const now = await $.clock.now()
        const m = crew.members
        const n = (st: string) => m.filter(k => k.state === st).length
        const running = n('running')
        const failed = n('failed')
        const head = [`${m.length} helper${m.length > 1 ? 's' : ''}`, n('done') ? `${n('done')} done` : '', running ? `${running} running` : '', failed ? `${failed} failed` : '', F.elapsed(now - crew.since)].filter(Boolean).join(' · ')
        const kinds = new Map<string, typeof m>()
        for (const k of m) kinds.set(k.kind, [...(kinds.get(k.kind) ?? []), k])
        const mark = SPIN[((await read($, spinRef)) ?? 0) % SPIN.length]!
        const cell = (st: string) => (st === 'done' ? '●' : st === 'running' ? '◐' : '✕')
        const ink = (st: string) => (st === 'done' ? GREEN_I : st === 'running' ? VIOLET_I : RED_I)
        return (
          <x.Box flexDirection="column">
            <x.Box flexDirection="row" gap={1} paddingLeft={PAD}>
              <x.Text color={VIOLET_I}>{running ? mark : '●'}</x.Text>
              <x.Text wrap="truncate-end">{head}</x.Text>
            </x.Box>
            {[...kinds.entries()].map(([kind, list]) => (
              <x.Box key={`k-${kind}`} flexDirection="row" gap={1} paddingLeft={PAD + 2}>
                <x.Text dimColor>{F.fit(kind, 18)}</x.Text>
                <x.Text>
                  {list.map((k, i) => (
                    <x.Text key={`c${i}`} color={ink(k.state)}>{cell(k.state)}</x.Text>
                  ))}
                </x.Text>
                <x.Text dimColor>{`${list.filter(k => k.state === 'done').length}/${list.length}`}</x.Text>
              </x.Box>
            ))}
          </x.Box>
        ) as never
      } catch {
        // fall through to the background-run line
      }
    }
    const live = await read($, liveRef)
    if (live === null) {
      const bg = await liveBg($)
      if (bg.length === 0) return next(e)
      try {
        // the turn is over, a background run is not: a slow breathing dot, no spinner, and you
        // can type as usual
        const x = els($, e)
        const now = await $.clock.now()
        const cols = Math.max(24, (e.viewport?.columns ?? 100) - 6)
        const first = bg[0]!
        const what = bg.some(b => TEST_WORDS.test(b.words)) ? 'Test running' : 'Running in the background'
        // a run with no description arrives as its raw command: name it in words instead
        const looksRaw = /[&|;$"\/]|^(cd|bash|python3?|node|npm|git|pgrep)\b/.test(first.words)
        const label = looksRaw ? F.stepWords('Bash', { command: first.words }) : first.words
        const typing = cols >= 90 ? ' · you can keep typing' : ''
        const tail = `· ${F.elapsed(now - first.at)}${typing}`
        const more = bg.length > 1 ? ` · +${bg.length - 1} more` : ''
        const phase = (((await read($, sweepRef)) ?? 0) >> 3) % 4
        const dot = ['·', '•', '●', '•'][phase]!
        return (
          <x.Box flexDirection="column">
            <x.Box flexDirection="row" gap={1} paddingLeft={PAD}>
              <x.Text color={ACCENT}>{dot}</x.Text>
              <x.Text wrap="truncate-end">{F.fit(`${what} · ${label}${more}`, cols - tail.length - 4)}</x.Text>
              <x.Text dimColor wrap="truncate-end">{tail}</x.Text>
            </x.Box>
          </x.Box>
        ) as never
      } catch {
        return next(e)
      }
    }
    // a live turn draws its step under the chat (the Spinner row); the band stays the engine's
    return next(e)
  })

  // A slash command's answer sits in the text column under its echo: a dim mark and the words,
  // no tree glyph; an error in red.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const s = await settingsOf($)
    if (s.raw || expandedView) return next(e)
    try {
      const x = els($, e)
      const isError = (e.props as { isError?: boolean }).isError === true
      const text = e.props.text.replace(/^chat-clean:\s*/, '').trim()
      if (text === '') return nothing(x.Box) as never
      return (
        <x.Box flexDirection="row" paddingLeft={PAD}>
          <x.Box width={2} flexShrink={0}>
            <x.Text dimColor>·</x.Text>
          </x.Box>
          <x.Box flexGrow={1} flexShrink={1}>
            {isError ? <x.Text color="red">{text}</x.Text> : <x.Text dimColor>{text}</x.Text>}
          </x.Box>
        </x.Box>
      ) as never
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const s = await settingsOf($)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `feed ${F.modeOf(s)} · /feed to switch`] } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const x = els($, e)
    return settingsPage($, x, await settingsOf($), e.props.bodyColumns) as never
  })

  on('ui.render', { component: 'Pane', requestId: LANES }, async ($, e) => {
    const x = els($, e)
    return (await lanePane($, x, e.props.bodyColumns)) as never
  })

  on('ui.press', async ($, e, next) => {
    await note($, `press ${e.component} ${e.surface} element=${String(e.element)}`)
    return next(e)
  })
}
