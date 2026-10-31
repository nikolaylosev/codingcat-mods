import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-dash', component: 'Pane', requestId: 'session-dash',
  props: { title: 'Session dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// A past session: 2 prompts, 4 Read calls, $0.40, ~4 minutes.
const past = (n: number) =>
  [
    { type: 'user', cwd: '/work/alpha', timestamp: `2026-10-2${n}T10:00:00Z`, message: { role: 'user', content: 'a' } },
    { type: 'user', timestamp: `2026-10-2${n}T10:01:00Z`, message: { role: 'user', content: 'b' } },
    ...[1, 2, 3, 4].map(i => ({
      type: 'assistant', timestamp: `2026-10-2${n}T10:0${i}:00Z`,
      message: { id: `m${n}${i}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${n}${i}`, name: 'Read' }], usage: { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 100 } },
    })),
    { type: 'cost-state', totalCostUSD: 0.4 },
  ].map(o => JSON.stringify(o)).join('\n')

test('findings compare this session with the norm and say what to do', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  let cost = 10
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/projects')
      ? [{ name: '-work-alpha', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [3, 4, 5].map(n => ({ name: `s${n}.jsonl`, kind: 'file', size: 100, mtimeMs: n, isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: past(Number(e.path.match(/s(\d)\.jsonl/)?.[1] ?? 3)) }))
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/work/alpha' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 170000, window: 200000, percent: 85 }, rateLimits: [], cost: { usd: cost } } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => e as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => (e.tool === 'Bash' ? ({ result: {}, isError: true, text: 'x', ref: 'r' } as never) : { result: {} }))

  await $.session.start({ cwd: '/work/alpha', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'dashboard', args: 'scan' } as never) // read the past sessions
  // This session: 1 prompt, 12 tool calls (6 failing Bash), $3 spent.
  await $.prompt.submit({ text: 'fix it' } as never)
  await $.turn.start({ text: 'fix it', turnId: 't1' })
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Bash', command: 'make' })
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  cost = 13
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 60000, isAborted: false, reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 5, output_tokens: 900, cache_read_input_tokens: 50000, cache_creation_input_tokens: 500 } } as never)

  const text = (await $.command.run({ command: 'dashboard', args: '' } as never)).text
  console.log(text.split('\n').slice(0, 24).join('\n'))
  expect(text).toContain('Context 85% full')
  expect(text).toContain('Bash failed 6 of 6 calls')
  expect(text).toMatch(/12\.0 tool calls per prompt, 6\.0× norm/)
  expect(text).toMatch(/API-equivalent cost per prompt \$3\.00/)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'tab-session' })
  expect(await ui.find({ type: 'Text', text: /What stands out/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Per prompt/ })).toBeTruthy()
  await ui.unmount()
})
