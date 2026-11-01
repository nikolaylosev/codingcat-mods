import { expect, test } from 'claude-code/testing'
import type { HistScan, HistSession } from '../types'
import { SCAN_KEY } from '../hooks/history'

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
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
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

const row = (o: object) => JSON.stringify(o)
const say = (m: number, content: unknown, extra: object = {}) => row({ type: 'user', timestamp: ts(m), message: { role: 'user', content }, ...extra })
const reply = (m: number, id: string, out: number, extra: object = {}) =>
  row({ type: 'assistant', timestamp: ts(m), message: { id, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${m}`, name: 'Bash' }], usage: { input_tokens: 1, output_tokens: out } }, ...extra })

const newest = async (kv: Map<string, unknown>, ready: (s: HistSession) => boolean) => {
  for (let i = 0; i < 40; i++) {
    const s = (kv.get(SCAN_KEY) as HistScan | undefined)?.sessions[0]
    if (s && ready(s)) return s
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('the summary never got ready')
}

test('a large log counts its subagents and only what the person wrote', async ($, on) => {
  const kv = new Map<string, unknown>()
  const main = [
    say(0, '<task-notification>a task finished</task-notification>'),
    say(1, [{ type: 'text', text: '<browser_instruction>closed</browser_instruction>' }, { type: 'text', text: '\n<pasted_content id="ab">fix the\nparser</pasted_content>' }], { cwd: '/work/huge-project' }),
    say(2, [{ type: 'text', text: 'and the tests' }]),
    say(3, '<div> looks wrong'),
    reply(4, 'm1', 100),
    reply(5, 's1', 10, { isSidechain: true }),
    reply(5, 's1', 10, { isSidechain: true }),
  ].join('\n')
  const sub = [
    say(0, 'the task', { isSidechain: true }),
    reply(1, 'a1', 50, { isSidechain: true }),
    reply(1, 'a1', 50, { isSidechain: true }),
    reply(2, 'a2', 70, { isSidechain: true }),
  ].join('\n')
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/big/subagents') ? [{ name: 'agent-1.jsonl', kind: 'file', size: sub.length, mtimeMs: 3, isLink: false }]
      : e.path.endsWith('/projects') ? [{ name: '-work-huge-project', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 'big.jsonl', kind: 'file', size: 9 * 1024 * 1024, mtimeMs: 7, isLink: false }],
  }))
  on('fs.read', () => ({ value: sub }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: main }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const s = await newest(kv, x => !x.path && !x.tooBig)
  expect(s.prompts).toBe(3)
  expect(s.firstPrompt).toBe('fix the parser')
  expect(s.subOut).toBe(10 + 50 + 70)
  expect(s.out).toBe(100 + 10 + 50 + 70)
  expect(s.subMsgs).toBe(3)
  expect(s.replies).toBe(1)
})

test('a large log that changed keeps its numbers until the new summary is ready', async ($, on) => {
  const old = {
    id: 'big', project: '/work/huge-project', folder: '-work-huge-project', size: 8 * 1024 * 1024, mtime: 6,
    start: Date.UTC(2026, 9, 30, 9, 0), end: Date.UTC(2026, 9, 30, 10, 0), activeMs: 60000, prompts: 7, commands: 0, replies: 9, calls: 5, errors: 0,
    out: 777, inp: 1, cr: 0, cw: 0, models: {}, tools: {}, toolErr: {}, subMsgs: 0, linesAdded: 0, linesRemoved: 0, commits: 0, prs: 0,
    rejections: 0, interrupts: 0, compactions: 0, apiErrors: 0, retryMs: 0, errKinds: {}, subOut: 0, subIn: 0, subCalls: 0,
    firstPrompt: 'the old title', usd: 4, big: true, tooBig: false,
  }
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: 0, dir: '/Users/nick/.claude/projects', sessions: [old], skipped: 0 }]])
  let release = () => {}
  const gate = new Promise<void>(r => { release = r })
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
      ? [{ name: '-work-huge-project', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 'big.jsonl', kind: 'file', size: 9 * 1024 * 1024, mtimeMs: 7, isLink: false }],
  }))
  on('process.spawn', async function* () {
    await gate
    yield { stream: 'stdout', text: [say(0, 'the new title', { cwd: '/work/huge-project' }), reply(1, 'm1', 5)].join('\n') }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  try {
    const waiting = await newest(kv, x => x.mtime === 7)
    expect(waiting.out).toBe(777)
    expect(waiting.tooBig).toBeFalsy()
    const text = (await $.command.run({ command: 'dashboard', args: 'history' } as never)).text
    expect(text).toContain('huge-project')
    expect(text).toContain('large logs')
  } finally {
    release()
  }
  const fresh = await newest(kv, x => !x.path)
  expect(fresh.out).toBe(5)
  expect(fresh.firstPrompt).toBe('the new title')
  expect(fresh.usd).toBeUndefined()
})

const LOG_DIR = '/Users/nick/.claude/projects/-work-huge-project'
const file = (name: string, mtimeMs: number) => ({ name, kind: 'file', size: 9 * 1024 * 1024, mtimeMs, isLink: false })

test('a summary that cannot be saved does not send the same log around again', async ($, on) => {
  const kv = new Map<string, unknown>()
  let reads = 0
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => {
    // Only the finished summary is refused. The limit ends the loop if it comes back.
    const waiting = (e.value as HistScan).sessions?.some(x => x.path)
    if (e.key === SCAN_KEY && !waiting && reads < 5) throw new Error('the store is full')
    kv.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
      ? [{ name: '-work-huge-project', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [file('big.jsonl', 7)],
  }))
  on('process.spawn', async function* () {
    reads++
    yield { stream: 'stdout', text: reply(1, 'm1', 5) }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  for (let i = 0; i < 40 && !reads; i++) await new Promise(r => setTimeout(r, 25))
  await new Promise(r => setTimeout(r, 150))
  expect(reads).toBe(1)
  expect((kv.get(SCAN_KEY) as HistScan).sessions[0]?.path).toBeTruthy()
})

test("this session's large log waits in the queue until another session reads it", async ($, on) => {
  const old = {
    id: 'mine', project: '/work/huge-project', folder: '-work-huge-project', size: 8 * 1024 * 1024, mtime: 6,
    start: Date.UTC(2026, 9, 30, 9, 0), end: Date.UTC(2026, 9, 30, 10, 0), activeMs: 60000, prompts: 7, commands: 0, replies: 9, calls: 5, errors: 0,
    out: 777, inp: 1, cr: 0, cw: 0, models: {}, tools: {}, toolErr: {}, subMsgs: 0, linesAdded: 0, linesRemoved: 0, commits: 0, prs: 0,
    rejections: 0, interrupts: 0, compactions: 0, apiErrors: 0, retryMs: 0, errKinds: {}, subOut: 0, subIn: 0, subCalls: 0, big: true, tooBig: false,
  }
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: 0, dir: '/Users/nick/.claude/projects', sessions: [old], skipped: 0 }]])
  const read: string[] = []
  let current = 'mine'
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
      ? [{ name: '-work-huge-project', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [file('mine.jsonl', 7), file('other.jsonl', 5)],
  }))
  on('process.spawn', async function* (_, e) {
    read.push(String(e.argv[1]))
    yield { stream: 'stdout', text: reply(1, 'm1', 5) }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: current }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  const session = (id: string) => (kv.get(SCAN_KEY) as HistScan | undefined)?.sessions.find(x => x.id === id)
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  for (let i = 0; i < 40 && !read.length; i++) await new Promise(r => setTimeout(r, 25))
  await new Promise(r => setTimeout(r, 100))
  expect(read).toEqual([`${LOG_DIR}/other.jsonl`])
  expect(session('mine')?.out).toBe(777)
  expect(session('mine')?.path).toBe(`${LOG_DIR}/mine.jsonl`)
  expect((await $.command.run({ command: 'dashboard', args: 'history' } as never)).text).not.toContain('large logs are being read')

  current = 'next'
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  for (let i = 0; i < 40 && session('mine')?.path; i++) await new Promise(r => setTimeout(r, 25))
  expect(read).toEqual([`${LOG_DIR}/other.jsonl`, `${LOG_DIR}/mine.jsonl`])
  expect(session('mine')?.out).toBe(5)
})
