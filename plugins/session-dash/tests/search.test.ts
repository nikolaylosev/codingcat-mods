import { expect, test } from 'claude-code/testing'

const log = (cwd: string, branch: string, prompt: string, day: number) =>
  [
    { type: 'user', cwd, gitBranch: branch, timestamp: `2026-10-${day}T10:00:00Z`, message: { role: 'user', content: prompt } },
    { type: 'assistant', timestamp: `2026-10-${day}T10:20:00Z`, message: { id: `m${day}`, model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ].map(o => JSON.stringify(o)).join('\n')

const FILES: Record<string, string> = {
  'a.jsonl': log('/work/sessionlens', 'feature/qa-api', 'Add the qa-api profile to the VS Code extension', 20),
  'b.jsonl': log('/work/sessionlens', 'main', 'Fix flaky playwright tests', 25),
  'c.jsonl': log('/work/council-review', 'main', 'Write the README for council review', 28),
}

test('search finds sessions by project, branch, prompt and date; the year heatmap draws', async ($, on) => {
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 31, 9, 0) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/projects') ? [{ name: '-work', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : e.path.endsWith('/subagents') ? []
      : Object.keys(FILES).map((name, i) => ({ name, kind: 'file', size: 10, mtimeMs: i + 1, isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: FILES[e.path.split('/').pop() ?? ''] ?? '' }))
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/work/sessionlens' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work/sessionlens', surface: null, isInteractive: true })
  await $.command.run({ command: 'dashboard', args: 'scan' } as never)

  const byBranch = (await $.command.run({ command: 'dashboard', args: 'search qa-api' } as never)).text
  console.log(byBranch)
  expect(byBranch).toContain('1 of 3 sessions')
  expect(byBranch).toContain('⎇ feature/qa-api')
  expect(byBranch).toContain('"Add the qa-api profile')

  const byWords = (await $.command.run({ command: 'dashboard', args: 'search council readme' } as never)).text
  expect(byWords).toContain('1 of 3 sessions')
  expect((await $.command.run({ command: 'dashboard', args: 'search 10-25' } as never)).text).toContain('Fix flaky playwright')
  expect((await $.command.run({ command: 'dashboard', args: 'search nothing-like-this' } as never)).text).toContain('0 of 3')

  const PANE = { plugin: 'session-dash', component: 'Pane', requestId: 'session-dash',
    props: { title: 'Session dashboard', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    await ui.press({ key: 'scope-all' })
    expect(await ui.find({ type: 'Text', text: /Your year/ })).toBeTruthy()
    if (surface !== 'mobile') {
      await ui.input({ key: 'search', text: 'playwright' })
      expect(await ui.find({ type: 'Text', text: /1 of 3 sessions match/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /Fix flaky playwright/ })).toBeTruthy()
      await ui.press({ key: 'search-clear' })
    }
    await ui.unmount()
  }
})
