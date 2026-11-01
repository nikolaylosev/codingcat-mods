import { expect, test } from 'claude-code/testing'
import type { HistScan, HistSession } from '../types'
import { ARCHIVE_KEY, SCAN_KEY } from '../hooks/history'

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
  const kv = new Map<string, unknown>([['search-prompts', true]])
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
  const kv = new Map<string, unknown>([['search-prompts', true], [SCAN_KEY, { at: 0, dir: '/Users/nick/.claude/projects', sessions: [old], skipped: 0 }]])
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

test("subagents' errors keep their kind, and a refusal by a rule is not the person's", async ($, on) => {
  const kv = new Map<string, unknown>()
  const row2 = (o: object) => JSON.stringify({ sessionId: 's', ...o })
  const fail = (id: string, text: string) => row2({ type: 'user', isSidechain: true, timestamp: ts(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } })
  const sub = [fail('a', 'bash: jq: command not found'), fail('b', 'Permission for this action was denied by the Claude Code auto mode classifier.'), fail('c', "The user doesn't want to proceed with this tool use.")].join('\n')
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/projects') ? [{ name: '-work-a', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : e.path.endsWith('/subagents') ? [{ name: 'agent-1.jsonl', kind: 'file', size: sub.length, mtimeMs: 3, isLink: false }]
      : [{ name: 's.jsonl', kind: 'file', size: 10, mtimeMs: 7, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: e.path.includes('/subagents/') ? sub : fail('z', 'bash: jq: command not found') }))
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const s = await newest(kv, x => x.errors > 0)
  expect(s.errors).toBe(4)
  expect(s.errKinds).toEqual({ 'command not found': 2, denied: 1, rejected: 1 })
  expect(s.rejections).toBe(1)
})

test('the logs are scanned again on a timer while a session stays open', async ($, on) => {
  const kv = new Map<string, unknown>()
  let t = Date.UTC(2026, 9, 31, 9, 0)
  let files = [{ name: 'a.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }]
  let period = 0
  let tick = () => {}
  const gate = new Promise<void>(r => { tick = r })
  on('clock.now', () => ({ value: t }))
  on('clock.every', async () => {
    if (period++ === 0) await gate
    else await new Promise(() => {})
    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects') ? [{ name: '-work-a', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : files,
  }))
  on('fs.read', () => ({ value: say(0, 'hello', { cwd: '/work/a' }) }))
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const count = () => (kv.get(SCAN_KEY) as HistScan | undefined)?.sessions.length ?? 0
  for (let i = 0; i < 40 && !count(); i++) await new Promise(r => setTimeout(r, 25))
  expect(count()).toBe(1)

  files = [...files, { name: 'b.jsonl', kind: 'file', size: 10, mtimeMs: 2, isLink: false }]
  t += 11 * 60 * 1000
  tick()
  for (let i = 0; i < 40 && count() < 2; i++) await new Promise(r => setTimeout(r, 25))
  expect(count()).toBe(2)
})

test('a deleted log stays in the history, survives a new scan key and gives way if it comes back', async ($, on) => {
  const kv = new Map<string, unknown>()
  const stored = new Map<string, { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }>([
    ['keep', { name: 'keep.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }],
    ['copy', { name: 'copy.jsonl', kind: 'file', size: 10, mtimeMs: 2, isLink: false }],
    ['huge', { name: 'huge.jsonl', kind: 'file', size: 9 * 1024 * 1024, mtimeMs: 3, isLink: false }],
  ])
  let refuseArchive = false
  let out = 40
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => {
    if (refuseArchive && e.key === ARCHIVE_KEY) throw new Error('the store is full')
    kv.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects') ? [{ name: '-work-a', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [...stored.values()],
  }))
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('copy.jsonl')
      ? say(0, 'an old prompt', { cwd: '/work/a', sessionId: 'someone-else' })
      : [say(0, 'keep this', { cwd: '/work/a' }), reply(1, 'm1', out)].join('\n'),
  }))
  on('process.spawn', async function* () {
    await new Promise(() => {}) // The large log is never ready: it stays a placeholder.
    yield { stream: 'stdout', text: '' }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const history = async (args = 'history scan') => (await $.command.run({ command: 'dashboard', args: `all ${args}` } as never)).text
  const archived = () => ((kv.get(ARCHIVE_KEY) ?? []) as HistSession[]).map(x => x.id)
  const cached = () => (kv.get(SCAN_KEY) as HistScan).sessions.map(x => x.id).sort()

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await history()
  expect(archived()).toEqual([])

  // The store refuses: the summary waits in the scan, not lost.
  stored.clear()
  refuseArchive = true
  await history()
  expect(cached()).toContain('keep')
  refuseArchive = false

  const text = await history()
  // Only a session with work of its own is kept: not a bare copy, not a placeholder.
  expect(archived()).toEqual(['keep'])
  expect(cached()).not.toContain('keep')
  expect((kv.get(ARCHIVE_KEY) as HistSession[])[0]?.archived).toBe(true)
  expect(text).toContain('1 kept from deleted logs')
  expect(text).toContain('All sessions · 1 in 1 projects')

  // A parser change starts a new scan key.
  kv.delete(SCAN_KEY)
  expect(await history()).toContain('All sessions · 1 in 1 projects')
  expect(archived()).toEqual(['keep'])

  // The log is back: its own numbers count, once.
  out = 77
  stored.set('keep', { name: 'keep.jsonl', kind: 'file', size: 11, mtimeMs: 9, isLink: false })
  const back = await history()
  expect(back).toContain('All sessions · 1 in 1 projects')
  expect(back).not.toContain('kept from deleted logs')
  expect(archived()).toEqual([])
  expect((kv.get(SCAN_KEY) as HistScan).sessions.find(x => x.id === 'keep')?.out).toBe(77)
})

test("a small log of this session is not read, a large subagent log is, and old scans leave the store", async ($, on) => {
  const kv = new Map<string, unknown>([['scan-1', {}], ['scan-7', {}], ['stats-x', 1], ['archive-1', []]])
  const read: string[] = []
  const streamed: string[] = []
  const sub = [say(0, 'the task', { isSidechain: true }), reply(1, 'a1', 50, { isSidechain: true })].join('\n')
  let current = 'mine'
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('store.keys', () => ({ value: [...kv.keys()] }))
  on('store.delete', (_, e) => { kv.delete(e.key); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/projects') ? [{ name: '-work-a', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : e.path.endsWith('/other/subagents') ? [file('agent-1.jsonl', 3)]
      : e.path.endsWith('/subagents') ? []
      : [{ name: 'mine.jsonl', kind: 'file', size: 10, mtimeMs: 2, isLink: false }, { name: 'other.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }],
  }))
  on('fs.read', (_, e) => { read.push(e.path); return { value: [say(0, 'hello', { cwd: '/work/a' }), reply(1, 'm1', 5)].join('\n') } })
  on('process.spawn', async function* (_, e) {
    streamed.push(String(e.argv[1]))
    yield { stream: 'stdout', text: sub }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: current }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const scanned = () => (kv.get(SCAN_KEY) as HistScan | undefined)?.sessions ?? []

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  for (let i = 0; i < 40 && !scanned().length; i++) await new Promise(r => setTimeout(r, 25))
  await new Promise(r => setTimeout(r, 50))
  expect(read.filter(p => p.endsWith('mine.jsonl'))).toEqual([])
  expect(scanned().map(x => x.id)).toEqual(['other'])
  expect(streamed).toEqual([`${LOG_DIR.replace('-work-huge-project', '-work-a')}/other/subagents/agent-1.jsonl`])
  const other = scanned()[0]
  expect(other?.out).toBe(5 + 50)
  expect(other?.subOut).toBe(50)

  // The session is over: the next one reads its log.
  expect([...kv.keys()].filter(k => k.startsWith('scan-'))).toEqual([SCAN_KEY])
  expect(kv.has('stats-x')).toBe(true)
  current = 'next'
  await $.command.run({ command: 'dashboard', args: 'history scan' } as never)
  expect(read.filter(p => p.endsWith('mine.jsonl')).length).toBe(1)
  expect(scanned().map(x => x.id).sort()).toEqual(['mine', 'other'])
})

test('no prompt text stays in the store unless the person asks, and asking again takes it out', async ($, on) => {
  const kv = new Map<string, unknown>()
  const stored = new Map([
    ['small', { name: 'small.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }],
    ['huge', file('huge.jsonl', 2)],
  ])
  const log = (text: string) => [say(0, text, { cwd: '/work/a' }), reply(1, 'm1', 5)].join('\n')
  let t = Date.UTC(2026, 9, 31, 9, 0)
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects') ? [{ name: '-work-a', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [...stored.values()],
  }))
  on('fs.read', () => ({ value: log('PROMPTSMALL text') }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: log('PROMPTHUGE text') }
    return { value: { code: 0, signal: null } }
  } as never)
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const run = async (args: string) => (await $.command.run({ command: 'dashboard', args } as never)).text
  const inStore = () => JSON.stringify([...kv.entries()].filter(([k]) => k !== 'search-prompts'))
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 60 && !ready(); i++) await new Promise(r => setTimeout(r, 25))
    expect(ready()).toBe(true)
  }
  const bothRead = () => (kv.get(SCAN_KEY) as HistScan | undefined)?.sessions.filter(x => x.out > 0).length === 2

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await until(bothRead)
  expect(inStore()).not.toContain('PROMPT')
  const none = await run('search PROMPTSMALL')
  expect(none).toContain('0 of 2')
  expect(none).toContain('/dashboard prompts on')

  await run('prompts on')
  await until(() => inStore().includes('PROMPTSMALL') && inStore().includes('PROMPTHUGE'))
  expect(await run('search PROMPTSMALL')).toContain('1 of 2')

  // A log deleted now takes its text to the archive; off takes it out of there too.
  stored.delete('small')
  await run('scan')
  expect(JSON.stringify(kv.get(ARCHIVE_KEY))).toContain('PROMPTSMALL')
  await run('prompts off')
  expect(inStore()).not.toContain('PROMPT')
  expect((kv.get(ARCHIVE_KEY) as HistSession[]).map(x => x.id)).toEqual(['small'])
})
