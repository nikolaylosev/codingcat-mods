import { expect, test } from 'claude-code/testing'
import { SCAN_KEY } from '../hooks/history'

const BAND = (bodyColumns: number) => ({
  plugin: 'session-dash', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}) as const

test('one band: live figures from the first tool call, a finding when there is one, no status line', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  let statuses = 0
  let fail = false
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'current' }))
  on('session.usage', () => ({ value: {
    startedAt: 0, context: { tokens: 84000, window: 200000, percent: 42 }, cost: { usd: 1.54 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(Date.UTC(2026, 9, 31, 12, 0)).toISOString() }],
  } }))
  on('ui.status', () => { statuses++; return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => (fail ? ({ result: {}, isError: true, text: 'nope: command not found', ref: 'r' } as never) : { result: {} }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  // The first turn is still running: no turn has completed yet.
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND(100), surface } as never)
    expect(await ui.find({ type: 'Text', text: /Context 42%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /5h 30%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$1\.54 API-eq\./ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 calls/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /turns|0ms|0 out|cache 0%|0 err/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /failed/ })).toBeFalsy()
    await ui.unmount()
  }

  // Narrow: the most pressing figures stay, the rest goes.
  const narrow = await $.ui.mount({ ...BAND(30), surface: 'terminal' } as never)
  expect(await narrow.find({ type: 'Text', text: /Context 42%/ })).toBeTruthy()
  expect(await narrow.find({ type: 'Text', text: /\/dashboard/ })).toBeFalsy()
  await narrow.unmount()

  fail = true
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'nope' } as never)
  const ui = await $.ui.mount({ ...BAND(100), surface: 'vscode' } as never)
  expect(await ui.find({ type: 'Text', text: /3 err/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Bash failed 3 of 3 calls/ })).toBeTruthy()
  await ui.unmount()

  expect(statuses).toBe(0)
})

test('the band says when limits reset, the day so far, what is unusual, the room left and what is running', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  let percent = 40
  let release = () => {}
  const gate = new Promise<void>(r => { release = r })
  const earlier = (id: string) => ({
    id, project: '/work/alpha', folder: '-work-alpha', size: 100, mtime: 1, start: t - 1000, end: t, activeMs: 3600000,
    prompts: 2, commands: 0, replies: 2, calls: 4, errors: 0, out: 200, inp: 0, cr: 0, cw: 0, models: {}, tools: {}, toolErr: {}, subMsgs: 0,
    linesAdded: 0, linesRemoved: 0, commits: 0, prs: 0, rejections: 0, interrupts: 0, compactions: 0, apiErrors: 0, retryMs: 0, errKinds: {},
    subOut: 0, subIn: 0, subCalls: 0, usd: 5,
  })
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: t, dir: '/p', sessions: [earlier('a'), earlier('b')], skipped: 0 }]])
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'current' }))
  on('session.usage', (_, e) => ({ value: {
    startedAt: 0, cost: { usd: 3 },
    context: { tokens: percent * 2000, window: 200000, percent, ...(e.breakdown ? { breakdown: { autoCompactThreshold: 180000, isAutoCompactEnabled: true } } : {}) },
    rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(Date.UTC(2026, 9, 31, 12, 0)).toISOString() }],
  } }) as never)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => e as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash') await gate
    return { result: {} }
  })
  const turn = async (id: string, fill: number) => {
    percent = fill
    await $.prompt.submit({ text: 'go' } as never)
    await $.turn.start({ text: 'go', turnId: id })
    await $.turn.complete({ turnId: id, answer: '', durationMs: 60000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 5, output_tokens: 900 } } as never)
  }
  const shown = async (re: RegExp, columns = 140) => {
    const ui = await $.ui.mount({ ...BAND(columns), surface: 'vscode' } as never)
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()
    return hit
  }

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await turn('t1', 40)
  await turn('t2', 48)
  await turn('t3', 55)
  expect(await shown(/5h 30%, reset 3h 0m/)).toBeTruthy()
  // 7.5% a prompt, compacted at 90%: 35 / 7.5 rounds down to 4.
  expect(await shown(/Context 55%, ~4 prompts left/)).toBeTruthy()
  expect(await shown(/Today 2h 3m/)).toBeTruthy()
  expect(await shown(/3 sessions/)).toBeTruthy()
  expect(await shown(/\$13\.00 API-eq\./)).toBeTruthy()
  expect(await shown(/Tokens\/prompt 9\.0× norm/)).toBeTruthy()
  expect(await shown(/running/)).toBeFalsy()

  const open = $.tool.call({ tool: 'Bash', command: 'sleep' } as never)
  try {
    await new Promise(r => setTimeout(r, 10))
    expect(await shown(/Bash running…/)).toBeTruthy()
    // A call the turn outlived is not reported as running for ever.
    await turn('t4', 58)
    expect(await shown(/running/)).toBeFalsy()
    expect(await shown(/Context 58%/)).toBeTruthy()
  } finally {
    release()
  }
  await open

  // A compaction restarts the estimate; a warning takes the second row.
  await turn('t5', 30)
  expect(await shown(/prompts left/)).toBeFalsy()
  await turn('t6', 62)
  expect(await shown(/Context 62% full/)).toBeTruthy()
  expect(await shown(/Today/)).toBeFalsy()
})

test('a click on the band opens the pane; the apps keep every figure and a limit does not hide the day', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  const kv = new Map<string, unknown>()
  const toasts: string[] = []
  let opened = 0
  let placed = true
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'current' }))
  on('session.usage', () => ({ value: {
    startedAt: 0, context: { tokens: 8000, window: 200000, percent: 4 }, cost: { usd: 3 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 100, resetsAt: new Date(Date.UTC(2026, 9, 31, 12, 0)).toISOString() },
      { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(Date.UTC(2026, 10, 3, 12, 0)).toISOString() },
    ],
  } }))
  on('ui.open', () => { opened++; return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } } })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  const id = 't1'
  await $.turn.start({ text: 'go', turnId: id })
  await $.turn.complete({ turnId: id, answer: '', durationMs: 60000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 5, output_tokens: 900 } } as never)

  // The app reports 50 cells and has room for more than twice that.
  const app = await $.ui.mount({ ...BAND(50), surface: 'vscode' } as never)
  expect(await app.find({ type: 'Text', text: /7d 12%, reset/ })).toBeTruthy()
  expect(await app.find({ type: 'Text', text: /\/dashboard/ })).toBeTruthy()
  // Used up: the first row says so, and the second keeps its place.
  expect(await app.find({ type: 'Text', text: /5h 100%, reset/ })).toBeTruthy()
  expect(await app.find({ type: 'Text', text: /limit used up/ })).toBeFalsy()
  expect(await app.find({ type: 'Text', text: /Today/ })).toBeTruthy()

  const before = opened
  await app.press({ key: 'band-figures' })
  await app.press({ key: 'band-info' })
  expect(opened).toBe(before + 2)
  expect(toasts).toEqual([])
  placed = false
  await app.press({ key: 'band-figures' })
  await new Promise(r => setTimeout(r, 10))
  expect(toasts).toEqual(['The dashboard did not open: no-surface'])
  await app.unmount()

  const term = await $.ui.mount({ ...BAND(50), surface: 'terminal' } as never)
  expect(await term.find({ type: 'Text', text: /\/dashboard/ })).toBeFalsy()
  await term.unmount()
})
