import { expect, test } from 'claude-code/testing'

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
