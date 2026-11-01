import { expect, test } from 'claude-code/testing'

test('detailed report', async ($, on) => {
  let t = 1_761_800_000_000
  on('clock.now', () => ({ value: (t += 1500) }))
  on('session.id', () => ({ value: 'current' }))
  on('fs.exists', () => ({ value: false }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'dashboard' } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 34000, window: 200000, percent: 17 }, rateLimits: [], cost: { usd: 1.54 } } }))
  on('tool.call', (_, e) => (e.tool === 'Edit' ? { result: {}, isError: true, text: 'x', ref: 'r' } as never : { result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => e as never)
  on('command.run', () => ({ text: 'engine' }))
  const kv = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  for (let i = 0; i < 4; i++) {
    await $.turn.start({ text: `собери мод номер ${i} и проверь его`, turnId: `t${i}` })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    if (i === 2) await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' } as never)
    await $.turn.complete({
      turnId: `t${i}`, answer: '', durationMs: 4000 + i * 9000, isAborted: false, reason: 'answer',
      usage: { model: 'claude-opus-5-5', input_tokens: 20, output_tokens: 900 + i * 400, cache_read_input_tokens: 30000, cache_creation_input_tokens: 1200 },
    } as never)
  }
  const r = await $.command.run({ command: 'dashboard', args: '' } as never)
  console.log(r.text)
  expect(r.text).toContain('SESSION DASHBOARD')
})
