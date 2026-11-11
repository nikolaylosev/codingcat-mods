import { expect, test } from 'claude-code/testing'
import { barsSvg } from '../hooks/charts'
import { SCAN_KEY } from '../hooks/history'

const PANE = {
  plugin: 'session-dash', component: 'Pane', requestId: 'session-dash',
  props: { title: 'Session dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('pane draws with data on every surface', async ($, on) => {
  let t = 1_761_800_000_000
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: (t += 1500) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('session.id', () => ({ value: 'current' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
      ? [{ name: '-work-demo-app', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 's1.jsonl', kind: 'file', size: 100, mtimeMs: 5, isLink: false }],
  }))
  on('fs.read', () => ({ value: [
    { type: 'user', cwd: '/work/demo-app', timestamp: '2026-10-29T10:00:00Z', message: { role: 'user', content: 'go' } },
    { type: 'assistant', timestamp: '2026-10-29T10:03:00Z', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'a', name: 'Edit' }], usage: { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } },
  ].map(o => JSON.stringify(o)).join('\n') }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 34000, window: 200000, percent: 17 }, rateLimits: [], cost: { usd: 1.54 } } }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 3; i++) {
    await $.turn.start({ text: `p${i}`, turnId: `t${i}` })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({ turnId: `t${i}`, answer: '', durationMs: 4000 + i * 900, isAborted: false, reason: 'answer',
      usage: { model: 'm', input_tokens: 20, output_tokens: 900, cache_read_input_tokens: 30000, cache_creation_input_tokens: 1200 } } as never)
  }
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeFalsy()
    await ui.press({ key: 'details' })
    const row = await ui.find({ type: 'Text', text: /Bash/ })
    expect(row).toBeTruthy()
    await ui.press({ key: 'details' })
    await ui.press({ key: 'tab-history' })
    const proj = await ui.find({ type: 'Text', text: /demo-app/ })
    expect(proj).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Projects/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /without the running session until it ends/ })).toBeTruthy()
    await ui.press({ key: 'tab-session' })
    await ui.unmount()
  }
})

test('bars are a drawing that can shrink in the apps, and text on the terminal', async ($, on) => {
  const day = Date.UTC(2026, 9, 31, 9, 0)
  const past = {
    id: 'a', project: '/work/app', folder: '-work-app', size: 1, mtime: 1, start: day - 3600000, end: day, activeMs: 600000,
    prompts: 2, commands: 0, replies: 2, calls: 4, errors: 0, out: 200, inp: 10, cr: 30, cw: 5, models: {}, tools: {}, toolErr: {}, subMsgs: 0,
    linesAdded: 0, linesRemoved: 0, commits: 0, prs: 0, rejections: 0, interrupts: 0, compactions: 0, apiErrors: 0, retryMs: 0, errKinds: {},
    subOut: 0, subIn: 0, subCalls: 0, usd: 2.5,
  }
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: day, dir: '/p', sessions: [past], skipped: 0 }]])
  on('clock.now', () => ({ value: day }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 1 }, cost: { usd: 0 }, rateLimits: [] } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const props = { bodyColumns: 50, scroll: { offset: 0, bodyRows: 200 } }

  const app = await $.ui.mount({ plugin: 'session-dash', component: 'Pane', requestId: 'session-dash', surface: 'vscode', props } as never)
  await app.press({ key: 'tab-history' })
  const drawings = await app.findAll({ type: 'Svg' })
  for (const title of ['Dollars per day', 'Active time per day', 'Active time per hour']) {
    const drawn = drawings.find(d => String(d.props.alt).startsWith(title))
    expect([title, !!drawn, drawn?.props.width]).toEqual([title, true, undefined])
    expect(String(drawn?.props.source)).toContain('<rect')
    expect(String(drawn?.props.source)).not.toContain('NaN')
  }
  expect(await app.find({ type: 'Text', text: /[▁▂▃▄▅▆▇█]{5}/ })).toBeFalsy()
  await app.unmount()

  const term = await $.ui.mount({ plugin: 'session-dash', component: 'Pane', requestId: 'session-dash', surface: 'terminal', props } as never)
  await term.press({ key: 'tab-history' })
  expect(await term.find({ type: 'Text', text: /[▁▂▃▄▅▆▇█]{5}/ })).toBeTruthy()
  await term.unmount()
})

test('few bars carry their numbers and keep a narrow width; many bars get an axis instead', () => {
  const few = barsSvg([1000, 65000, 40000], '#000', { label: v => `${v / 1000}s` })
  for (const n of ['1s', '65s', '40s']) expect(few).toContain(`>${n}</text>`)
  const width = Number(/<rect [^>]*width="([\d.]+)"/.exec(few)?.[1])
  expect(width).toBeLessThan(80)

  const many = barsSvg(Array.from({ length: 30 }, (_, i) => i), '#000', { label: String, ticks: [{ at: 0, text: 'start' }, { at: 29, text: 'today' }] })
  expect(many.match(/<text/g)?.length).toBe(2)
  expect(many).toContain('text-anchor="end"')

  // Nothing to draw is still a drawing.
  expect(barsSvg([], '#000')).not.toContain('NaN')
  expect(barsSvg([0, 0], '#000', { label: String })).not.toContain('NaN')
})
