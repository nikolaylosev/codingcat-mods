import { expect, test } from 'claude-code/testing'

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
      ? [{ name: '-work-sessionlens', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 's1.jsonl', kind: 'file', size: 100, mtimeMs: 5, isLink: false }],
  }))
  on('fs.read', () => ({ value: [
    { type: 'user', cwd: '/work/sessionlens', timestamp: '2026-10-29T10:00:00Z', message: { role: 'user', content: 'go' } },
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
    const proj = await ui.find({ type: 'Text', text: /sessionlens/ })
    expect(proj).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Projects/ })).toBeTruthy()
    await ui.press({ key: 'tab-session' })
    await ui.unmount()
  }
})
