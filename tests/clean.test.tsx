import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import * as F from '../hooks/feed'
import { frame } from './frame'

const PLUGIN = 'chat-clean'
const SURFACES = ['terminal', 'desktop'] as const
const COLS = 100
const VIEW = { columns: COLS, rows: 40, isFullscreen: true }
const PRESENTATION = { isFullscreen: true, columns: COLS }

type Answer = { stdout?: string; error?: string; result?: unknown }

// The engine beneath the plugin: each tool call answers when the test opens its gate.
function world(on: On) {
  const ids: string[] = []
  const gates: ((a?: Answer) => void)[] = []
  const store: Record<string, unknown> = {}
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', (_$, e) => ({ model: 'm', agentId: `agent-${e.tool_use_id}` }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('tool.call', (_$, e) => {
    ids.push(e.tool_use_id)
    return new Promise(resolve => {
      gates.push((a?: Answer) =>
        resolve(
          (a?.error !== undefined
            ? { result: a.error, text: a.error, isError: true }
            : { result: a?.result ?? { stdout: a?.stdout ?? 'ok', stderr: '', interrupted: false } }) as never,
        ),
      )
    })
  })
  return { ids, gates, store }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true } as never)
}
const command = (args: string) => ({ command: 'feed', args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })
function shot(name: string, tree: unknown) {
  const out = (globalThis as { console?: { log: (s: string) => void } }).console
  out?.log(`<<<FRAME ${name}>>>\n${frame(tree, COLS)}\n<<<END>>>`)
}
let seq = 0
const toolUse = (id: string, tool: string, input: unknown, isRunning = false) => ({
  plugin: PLUGIN,
  component: 'ToolUse' as const,
  requestId: `${id}#${seq++}`,
  props: { tool_use_id: id, tool, input, isRunning, isErrored: false, isInterrupted: false },
  viewport: VIEW,
})
const spinner = (mode: 'thinking' | 'tool-use' | 'responding') => ({
  plugin: PLUGIN,
  component: 'Spinner' as const,
  requestId: `main#${seq++}`,
  props: { word: 'Sauteing', message: null, suffix: '…', mode },
  viewport: VIEW,
})
const band = (surface: 'terminal' | 'desktop') => ({ plugin: PLUGIN, component: 'AbovePrompt' as const, requestId: `band#${seq++}`, props: { hasSurvey: false, isWorking: false, maxRows: 3 }, viewport: VIEW, surface }) as never
async function call($: Engine, w: ReturnType<typeof world>, clock: ReturnType<typeof mock.clock>, input: Record<string, unknown>, a?: Answer) {
  const p = $.tool.call(input as never)
  await clock.advance(1)
  w.gates[w.gates.length - 1]!(a)
  await p
  return w.ids[w.ids.length - 1]!
}
const HIDDEN = { type: 'Box', props: { display: 'none' } }

test('labels never show a raw command, a path or an id', () => {
  expect(F.stepWords('Bash', { command: 'cd /private/tmp/x && python3 run.py' })).toBe('Running a shell command')
  expect(F.stepWords('Bash', { command: 'T=43eb2245-3064-4ce4-ad9a-8d13c69564ba; make deploy $T', description: 'Deploy the site' })).toBe('Deploy the site')
  expect(F.stepWords('Bash', { command: 'x', description: 'Run the tests in /private/tmp/a438b492-b3f4-466f-86b2-2ea2e0000000/run' })).toBe('Run the tests in run')
  expect(F.stepWords('Read', { file_path: '/repo/src/app.py' })).toBe('Reading app.py')
  expect(F.stepWords('Grep', { pattern: 'foo.*bar' })).toBe('Searching the code')
  expect(F.stepWords('Agent', { prompt: 'long brief', subagent_type: 'general-purpose' })).toBe('Asking a helper')
  expect(F.stepWords('WebFetch', { url: 'https://www.example.com/a/b?c=1' })).toBe('Opening example.com')
  expect(F.fit('Running the very long test command for the release', 30)).toBe('Running the very long test…')
})

test('clean: a turn of calls is ONE line "{n} steps this turn"; it opens in place; the working line names the call with its own clock', { timeoutMs: 30000 }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const w = world(on)
  await start($)
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  const a = await call($, w, clock, { tool: 'Bash', command: 'git status' })
  await call($, w, clock, { tool: 'Read', file_path: '/repo/README.md' })
  const p = $.tool.call({ tool: 'Bash', command: 'T=43eb2245-3064-4ce4-ad9a-8d13c69564ba; npm test', description: 'Running the test suite' } as never)
  await clock.advance(1)
  await clock.advance(19000)
  const c = w.ids[2]!
  for (const surface of SURFACES) {
    const first = await $.ui.mount({ ...toolUse(a, 'Bash', { command: 'git status' }), surface })
    shot(`clean-open-turn-${surface}`, await first.drawn())
    expect(await first.find({ type: 'Text', text: '2 steps this turn' })).toBeDefined()
    // the call in flight has no row of its own: the working line names it
    const live = await $.ui.mount({ ...toolUse(c, 'Bash', {}, true), surface })
    expect(await live.drawn()).toMatchObject(HIDDEN)
    const s = await $.ui.mount({ ...spinner('tool-use'), surface })
    shot(`clean-live-${surface}`, await s.drawn())
    expect(await s.find({ type: 'Text', text: 'Running the test suite · 19s · step 3' })).toBeDefined()
  }
  w.gates[2]!()
  await p
  await $.turn.complete({ answer: 'done', durationMs: 25000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const first = await $.ui.mount({ ...toolUse(a, 'Bash', { command: 'git status' }), surface: 'terminal' })
  expect(await first.find({ type: 'Text', text: '3 steps this turn' })).toBeDefined()
  shot('clean-spent-turn-closed', await first.drawn())
  await first.press({ key: 'turn-t1' })
  shot('clean-spent-turn-opened', await first.drawn())
  expect(await first.find({ type: 'Text', text: 'Ran 2 shell commands · read 1 file' })).toBeDefined()
  await first.press({ key: 'turn-t1' })
  expect(await first.find({ type: 'Text', text: 'Ran 2 shell commands · read 1 file' })).toBeUndefined()
  // the working line leaves with the turn, and the turn-end timing row is not drawn
  const idle = await $.ui.mount({ ...spinner('thinking'), surface: 'terminal' })
  expect(await idle.drawn()).toMatchObject(HIDDEN)
  const dur = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 3000 }, viewport: VIEW })
  expect(await dur.drawn()).toMatchObject(HIDDEN)
})

test('normal: each run is one line with counts and a +N lines chip; the call in flight is named once', { timeoutMs: 30000 }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const w = world(on)
  await start($)
  expect((await $.command.run(command('normal'))).text).toContain('Chat view: normal')
  await $.turn.start({ text: 'look', turnId: 't1' })
  const a = await call($, w, clock, { tool: 'Bash', command: 'ls' }, { stdout: 'a\nb\nc' })
  await call($, w, clock, { tool: 'Bash', command: 'git log -3' }, { stdout: 'x\ny' })
  const p = $.tool.call({ tool: 'Bash', command: 'cd /private/tmp/x && sleep 9' } as never)
  await clock.advance(1)
  for (const surface of SURFACES) {
    const run = await $.ui.mount({ ...toolUse(a, 'Bash', {}), surface })
    shot(`normal-run-live-${surface}`, await run.drawn())
    expect(await run.find({ type: 'Text', text: 'Running a shell command' })).toBeDefined()
    const s = await $.ui.mount({ ...spinner('tool-use'), surface })
    expect(await s.find({ type: 'Text', text: 'Working · 0s · step 3' })).toBeDefined()
  }
  w.gates[2]!({ stdout: '' })
  await p
  const run = await $.ui.mount({ ...toolUse(a, 'Bash', {}), surface: 'terminal' })
  shot('normal-run-done', await run.drawn())
  expect(await run.find({ type: 'Text', text: 'Ran 3 shell commands' })).toBeDefined()
  expect(await run.find({ type: 'Text', text: '+5 lines' })).toBeDefined()
  await run.press({ key: `open-${a}` })
  shot('normal-run-opened', await run.drawn())
  expect(await run.find({ type: 'Text', text: 'Ran a shell command' })).toBeDefined()
})

test('a call a hook refused folds: one step in a spent clean turn, "1 step refused by a hook" in normal, its text a click away', { timeoutMs: 30000 }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const w = world(on)
  await start($)
  await $.command.run(command('normal'))
  await $.turn.start({ text: 'go', turnId: 't1' })
  const refusal = 'PreToolUse:Agent hook error: this helper needs a written brief.\nAlso, advisory: ...'
  const id = await call($, w, clock, { tool: 'Agent', description: 'Summarise the notes', prompt: 'x', subagent_type: 'general-purpose' }, { error: refusal })
  for (const surface of SURFACES) {
    const row = await $.ui.mount({ ...toolUse(id, 'Agent', {}), surface })
    shot(`refused-normal-${surface}`, await row.drawn())
    expect(await row.find({ type: 'Text', text: '1 step refused by a hook' })).toBeDefined()
  }
  const row = await $.ui.mount({ ...toolUse(id, 'Agent', {}), surface: 'terminal' })
  await row.press({ key: `open-${id}` })
  expect(await row.find({ type: 'Text', text: 'PreToolUse:Agent hook error: this helper needs a written brief.' })).toBeDefined()
  await $.command.run(command('clean'))
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const clean = await $.ui.mount({ ...toolUse(id, 'Agent', {}), surface: 'terminal' })
  expect(await clean.find({ type: 'Text', text: '1 step this turn' })).toBeDefined()
})

test('a helper row is never folded: running, then finished; an answered question is one line, question → answer', { timeoutMs: 30000 }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const w = world(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const p = $.tool.call({ tool: 'Agent', description: 'Read the notes', prompt: 'x', subagent_type: 'general-purpose' } as never)
  await clock.advance(1)
  await $.agent.spawn({ tool_use_id: w.ids[0]!, prompt: 'x', description: 'Read the notes', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } } as never)
  await clock.advance(4000)
  const agentId = w.ids[0]!
  const r1 = await $.ui.mount({ ...toolUse(agentId, 'Agent', {}, true), surface: 'terminal' })
  shot('agent-running', await r1.drawn())
  expect(await r1.find({ type: 'Text', text: 'Read the notes · dispatched · running · 4s' })).toBeDefined()
  await $.turn.complete({ answer: 'A', durationMs: 5000, isAborted: false, turnId: 'sub', agentId: `agent-${agentId}`, reason: 'answer' } as never)
  w.gates[0]!({ result: { content: 'A' } })
  await p
  const r2 = await $.ui.mount({ ...toolUse(agentId, 'Agent', {}), surface: 'terminal' })
  shot('agent-finished', await r2.drawn())
  expect(await r2.find({ type: 'Text', text: 'Read the notes · finished · 4s' })).toBeDefined()
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'chat-clean-helpers', props: { title: 'Helpers', isFocused: true, bodyColumns: COLS, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} }, viewport: VIEW })
  shot('helpers-pane', await pane.drawn())
  expect(await pane.find({ type: 'Text', text: 'Read the notes · finished · 4s' })).toBeDefined()
  const q = await call($, w, clock, { tool: 'AskUserQuestion', questions: [{ question: 'Which colour, red or blue?', header: 'Colour', options: [], multiSelect: false }] }, { result: { questions: [], answers: { 'Which colour, red or blue?': 'Red' } } })
  for (const surface of SURFACES) {
    const row = await $.ui.mount({ ...toolUse(q, 'AskUserQuestion', {}), surface })
    shot(`question-${surface}`, await row.drawn())
    expect(await row.find({ type: 'Text', text: 'Which colour, red or blue' })).toBeDefined()
    expect(await row.find({ type: 'Text', text: 'Red' })).toBeDefined()
  }
})

test('settings: /feed opens the page, every setting changes the stored settings, presets and hide/show work', { timeoutMs: 30000 }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  const w = world(on)
  await start($)
  expect((await $.command.run(command(''))).text).toContain('Chat view: clean')
  const page = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: 'chat-clean-feed',
    props: { title: 'Chat view', isFocused: true, bodyColumns: COLS, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: VIEW,
  })
  shot('settings-page', await page.drawn())
  await page.press({ key: 'btn-group' })
  expect((w.store.settings as { group: boolean }).group).toBe(false)
  for (const [args, key, value] of [
    ['clear off', 'clear', false],
    ['keep on', 'keep', true],
    ['style line', 'style', 'line'],
    ['commands each', 'commands', 'each'],
    ['after keep', 'after', 'keep'],
  ] as const) {
    await $.command.run(command(args))
    expect((w.store.settings as Record<string, unknown>)[key]).toBe(value)
  }
  await $.command.run(command('hide peer'))
  expect((w.store.settings as { hide: string[] }).hide).toEqual(['peer'])
  await $.command.run(command('raw'))
  const row = await $.ui.mount({ ...toolUse('toolu_Z', 'Bash', { command: 'ls' }), surface: 'terminal' })
  expect(await row.drawn()).toMatchObject({ type: 'engine' })
  expect((await $.command.run(command('loud'))).text).toContain('/feed opens the settings')
})

test('name column: your message reads "you", the reply reads "claude", desktop keeps its own look; a slash command answer is one quiet line', { timeoutMs: 30000 }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  world(on)
  await start($)
  const you = { plugin: PLUGIN, component: 'UserMessage' as const, props: { text: 'fix the login bug', origin: { kind: 'composer' as const }, isExpanded: false }, viewport: VIEW }
  const t = await $.ui.mount({ ...you, surface: 'terminal' })
  shot('you-terminal', await t.drawn())
  expect(await t.find({ type: 'Text', text: 'you' })).toBeDefined()
  expect(await t.find({ type: 'Text', text: 'fix the login bug' })).toBeDefined()
  const d = await $.ui.mount({ ...you, surface: 'desktop' })
  expect(await d.drawn()).toMatchObject({ type: 'engine' })
  const reply = { plugin: PLUGIN, component: 'AssistantMessage' as const, props: { text: 'Fixed: the token now refreshes.', isFirstOfReply: true }, viewport: VIEW }
  const r = await $.ui.mount({ ...reply, surface: 'terminal' } as never)
  shot('reply-terminal', await r.drawn())
  expect(await r.find({ type: 'Text', text: 'claude' })).toBeDefined()
  expect(await r.find({ type: 'Markdown' })).toBeDefined()
  const rd = await $.ui.mount({ ...reply, surface: 'desktop' } as never)
  expect(await rd.drawn()).toMatchObject({ type: 'engine' })
  const out = await $.ui.mount({ plugin: PLUGIN, component: 'CommandOutput', surface: 'terminal', props: { text: 'Chat view: clean.' }, viewport: VIEW } as never)
  shot('command-output', await out.drawn())
  expect(await out.find({ type: 'Text', text: 'Chat view: clean.' })).toBeDefined()
  // the time at the right edge is the stored time of the message, as hh:mm local
  expect(F.clock(new Date(2026, 9, 5, 9, 7).getTime())).toBe('09:07')
})

test('an API error reply is one line in the name column: amber when Claude Code handles it, red when you must act', { timeoutMs: 30000 }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  world(on)
  await start($)
  expect(F.errorLine('API Error: 529 Overloaded')).toEqual({ words: "Claude's servers are busy · not your setup · Claude Code retries, or send again", act: false })
  expect(F.errorLine("API Error: Sonnet 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).")).toEqual({ words: "Sonnet 5.5's safeguards stopped this reply · often a false alarm · esc esc to edit your message, or /model to switch", act: true, guard: true })
  expect(F.errorLine('Prompt is too long')).toEqual({ words: 'This chat is too long for the model · run /compact · nothing is lost', act: true })
  const frames = F.framesOfRaw('<teammate-message teammate_id="docs" summary="Docs built">\n{"type":"idle_notification","from":"docs","timestamp":"2026-10-06T06:25:17.980Z","result":"Built.\\n\\n- a\\n- b"}\n</teammate-message>')
  expect(frames[0]).toMatchObject({ from: 'docs', state: 'waiting', summary: 'Docs built' })
  expect(F.leadOf(frames[0]!.body)).toEqual({ lead: 'Built.', more: 2 })
  expect(F.errorLine('Claude AI usage limit reached, resets 3pm')?.act).toBe(true)
  expect(F.errorLine('A normal reply')).toBeNull()
  for (const surface of SURFACES) {
    const r = await $.ui.mount({ plugin: PLUGIN, component: 'AssistantMessage', surface, props: { text: 'API Error: Connection error.', isFirstOfReply: true }, viewport: VIEW } as never)
    shot(`error-${surface}`, await r.drawn())
    expect(await r.find({ type: 'Text', text: '!' })).toBeDefined()
    expect(await r.find({ type: 'Text', text: 'Connection lost' })).toBeDefined()
  }
})

test('background run: after the turn, a line above the input names it and says you can keep typing; a test reads "Test running"', { timeoutMs: 30000 }, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  world(on)
  on('classic.Stop', () => ({}) as never)
  await start($)
  const idle = await $.ui.mount(band('terminal'))
  expect(await idle.drawn()).toMatchObject({ type: 'engine' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'local_bash', status: 'running', description: 'Build the docs site' }] } as never)
  await clock.advance(120000)
  const one = await $.ui.mount(band('terminal'))
  shot('background-run', await one.drawn())
  expect(await one.find({ type: 'Text', text: 'Running in the background · Build the docs site' })).toBeDefined()
  expect(await one.find({ type: 'Text', text: '· 2m 0s · you can keep typing' })).toBeDefined()
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b2', type: 'local_bash', status: 'running', description: 'Run the unit tests' }] } as never)
  const two = await $.ui.mount(band('terminal'))
  shot('background-test', await two.drawn())
  expect(await two.find({ type: 'Text', text: 'Test running · Run the unit tests' })).toBeDefined()
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  const done = await $.ui.mount(band('terminal'))
  expect(await done.drawn()).toMatchObject({ type: 'engine' })
})

test('a message from another session or helper is one line; ctrl+o draws it whole', { timeoutMs: 30000 }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  world(on)
  await start($)
  for (const surface of SURFACES) {
    const peer = { plugin: PLUGIN, surface, component: 'UserMessage' as const, props: { text: 'Build finished.\nAll 12 checks pass.', origin: { kind: 'peer-send-message' as const }, from: { name: 'build-helper' }, isExpanded: false }, viewport: VIEW }
    const ui = await $.ui.mount(peer)
    shot(`peer-${surface}`, await ui.drawn())
    expect(await ui.find({ type: 'Text', text: 'build-helper · Build finished.' })).toBeDefined()
    const open = await $.ui.mount({ ...peer, props: { ...peer.props, isExpanded: true } })
    expect(await open.drawn()).toMatchObject({ type: 'engine' })
  }
})

test('answered questions: one pair per question, the question cut to its first sentence', async () => {
  expect(F.pairsOf({ answers: { 'Which look? Each is drawn on the page.': 'A · Ruled', 'Ship it now: yes or no?': 'Yes' } })).toEqual([
    { q: 'Which look', a: 'A · Ruled' },
    { q: 'Ship it now', a: 'Yes' },
  ])
  expect(F.pairsOf({ response: 'free text' }, { questions: [{ question: 'Anything else?' }] })).toEqual([{ q: 'Anything else', a: 'free text' }])
})

test('desktop: the band is the usage pill (5-hour and weekly), then one pill per running helper and test', { timeoutMs: 30000 }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-05T12:00:00Z') })
  world(on)
  on('classic.Stop', () => ({}) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, percent: 26 }, rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-05T14:40:00Z' }, { kind: 'seven_day', percentUsed: 49 }], cost: { usd: 4.1 } } }) as never)
  await start($)
  const quiet = await $.ui.mount(band('desktop'))
  shot('desktop-band-idle', await quiet.drawn())
  expect(await quiet.find({ type: 'Text', text: '20%' })).toBeDefined()
  expect(await quiet.find({ type: 'Text', text: '49%' })).toBeDefined()
  expect(await quiet.find({ type: 'Text', text: 'Test' })).toBeUndefined()
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'local_bash', status: 'running', description: 'Run the unit tests' }] } as never)
  const busy = await $.ui.mount(band('desktop'))
  shot('desktop-band-busy', await busy.drawn())
  expect(await busy.find({ type: 'Text', text: 'Test' })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: 'Run the unit tests' })).toBeDefined()
})
