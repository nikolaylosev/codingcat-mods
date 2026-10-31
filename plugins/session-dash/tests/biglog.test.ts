import { expect, test } from 'claude-code/testing'

const ts = (m: number) => new Date(Date.UTC(2026, 9, 30, 9, m)).toISOString()
const lines = [
  { type: 'user', cwd: '/work/huge-project', timestamp: ts(0), message: { role: 'user', content: 'refactor everything' } },
  ...Array.from({ length: 40 }, (_, i) => ({
    type: 'assistant', timestamp: ts(1 + i), message: { id: `m${i}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash' }], usage: { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
  })),
].map(o => JSON.stringify(o)).join('\n') + '\n'

test('a log over 4 MiB is read by streaming, cut mid-line', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  const kv = new Map<string, unknown>()
  let spawned: readonly string[] = []
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/projects')
      ? [{ name: '-work-huge-project', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 'big.jsonl', kind: 'file', size: 9 * 1024 * 1024, mtimeMs: 7, isLink: false }],
  }))
  on('fs.read', () => { throw new Error('too large') })
  on('process.spawn', async function* (_, e) {
    spawned = e.argv
    const cut = Math.floor(lines.length / 3)
    yield { stream: 'stdout', text: lines.slice(0, cut) }
    yield { stream: 'stdout', text: lines.slice(cut, cut * 2) }
    yield { stream: 'stdout', text: lines.slice(cut * 2) }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: 'current' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  let text = ''
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 25))
    text = (await $.command.run({ command: 'dashboard', args: 'history' } as never)).text
    if (text.includes('huge-project')) break
  }
  console.log(text.split('\n').filter(l => /huge|logs:|Bash /.test(l)).join('\n'))
  expect(spawned[0]).toBe('cat')
  expect(text).toContain('huge-project')
  expect(text).toContain('large logs read')
})
