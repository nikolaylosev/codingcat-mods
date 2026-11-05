import { expect, test } from 'claude-code/testing'

test('detailed report', async ($, on) => {
  let t = 1_761_800_000_000
  on('clock.now', () => ({ value: (t += 1500) }))
  on('session.id', () => ({ value: 'current' }))
  on('fs.exists', () => ({ value: false }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'session-dash' } }))
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
  const r = await $.command.run({ command: 'session-dash', args: '' } as never)
  console.log(r.text)
  expect(r.text).toContain('SESSION DASHBOARD')
})

test('this session\'s output says only what it knows, in the right number', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: (t += 1000) }))
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
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })

  // Edits made through the shell report no lines: a commit alone must not read as zero lines changed.
  await $.tool.call({ tool: 'Bash', command: 'git commit -m one' } as never)
  const report = async () => (await $.command.run({ command: 'session-dash', args: '' } as never)).text
  const pane = async () => {
    const ui = await $.ui.mount({ plugin: 'session-dash', component: 'Pane', requestId: 'session-dash', surface: 'vscode', props: { bodyColumns: 120, scroll: { offset: 0, bodyRows: 200 } } } as never)
    const texts = (await ui.findAll({ type: 'Text' })).map(x => String(x.text))
    await ui.unmount()
    return texts.find(x => x.startsWith('Output') && !x.startsWith('Output tokens')) ?? ''
  }
  expect(await report()).toContain('Output: 1 commit\n')
  expect(await pane()).toContain('1 commit')
  expect(await pane()).not.toContain('commits')
  expect(await pane()).not.toContain('+0')

  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b\nc' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m two' } as never)
  expect(await report()).toContain('Output: +2 −1 lines · 2 commits')
  expect(await pane()).toContain('2 commits')
  expect(await pane()).toContain('lines')
})

test('a refused command name does not stop the session from starting', async ($, on) => {
  let opened = 0
  on('clock.now', () => ({ value: 1_761_800_000_000 }))
  on('session.id', () => ({ value: 'current' }))
  on('fs.exists', () => ({ value: false }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => { throw new Error('a built-in has this name') })
  on('ui.open', () => { opened++; return { value: { isPlaced: false, reason: 'no-surface' } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))

  const started = await $.session.start({ cwd: '/here', surface: null, isInteractive: true })
  expect(started.cwd).toBe('/here')
  expect(opened).toBe(1)
})
