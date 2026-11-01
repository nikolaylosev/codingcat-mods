import { expect, test } from 'claude-code/testing'

const ts = (m: number) => new Date(Date.UTC(2026, 9, 29, 10, m)).toISOString()
const log = [
  { type: 'user', cwd: '/work/sessionlens', timestamp: ts(0), message: { role: 'user', content: 'add a test' } },
  { type: 'assistant', timestamp: ts(1), message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'a', name: 'Bash' }], usage: { input_tokens: 5, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 100 } } },
  { type: 'user', timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] } },
  { type: 'assistant', timestamp: ts(3), message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'b', name: 'Edit' }], usage: { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } } },
  { type: 'user', timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
  { type: 'cost-state', totalCostUSD: 0.42 },
].map(o => JSON.stringify(o)).join('\n')

test('history from logs', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
      ? [{ name: '-work-sessionlens', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 's1.jsonl', kind: 'file', size: log.length, mtimeMs: 5, isLink: false }],
  }))
  on('fs.read', () => ({ value: log }))
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const r = await $.command.run({ command: 'dashboard', args: 'history' } as never)
  console.log(r.text)
  expect(r.text).toContain('sessionlens')
  expect(r.text).toContain('$0.42')
})
