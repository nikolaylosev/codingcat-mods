import { expect, test } from 'claude-code/testing'

const log = (cwd: string, calls: number) =>
  [
    { type: 'user', cwd, timestamp: '2026-10-29T10:00:00Z', message: { role: 'user', content: 'go' } },
    ...Array.from({ length: calls }, (_, i) => ({
      type: 'assistant', timestamp: `2026-10-29T10:0${i + 1}:00Z`,
      message: { id: `m${i}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read' }], usage: { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    })),
  ].map(o => JSON.stringify(o)).join('\n')

test('history shows only the current project, or every project on request', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
      ? [{ name: '-work-alpha', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, { name: '-work-beta', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: e.path.endsWith('alpha') ? 'a.jsonl' : 'b.jsonl', kind: 'file', size: 100, mtimeMs: 5, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: e.path.includes('alpha') ? log('/work/alpha/src', 3) : log('/work/beta', 7) }))
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/work/alpha' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work/alpha', surface: null, isInteractive: true })
  const mine = (await $.command.run({ command: 'dashboard', args: 'history' } as never)).text
  expect(mine).toContain('Project alpha · 1 sessions')
  expect(mine).not.toContain('beta')

  const every = (await $.command.run({ command: 'dashboard', args: 'all' } as never)).text
  expect(every).toContain('All sessions · 2 in 2 projects')
  expect(every).toContain('beta')

  const back = (await $.command.run({ command: 'dashboard', args: 'project' } as never)).text
  expect(back).toContain('Project alpha')
})
