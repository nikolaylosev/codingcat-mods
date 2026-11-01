import { expect, test } from 'claude-code/testing'
import { dayKey, daysOf, msPerDay, sinceDay } from '../hooks/days'
import { parseLog } from '../hooks/history'

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

test('API request lines count only for their time', () => {
  const base = { id: 'x', project: '', folder: '', size: 0, mtime: 0 }
  const at = (m: number) => new Date(Date.UTC(2026, 9, 29, 10, m)).toISOString()
  const request = { type: 'api-request', sessionId: 'x', id: 'r', timestamp: at(4), params: { messages: [{ role: 'user', content: 'not a prompt', cwd: '/not/this' }] } }
  const s = parseLog([
    JSON.stringify({ type: 'user', timestamp: at(0), cwd: '/work/app', message: { role: 'user', content: 'a prompt' } }),
    JSON.stringify(request),
    JSON.stringify({ type: 'api-request-blob', id: 'b', data: { timestamp: at(30) } }),
    JSON.stringify({ type: 'user', timestamp: at(8), message: { role: 'user', content: 'another prompt' } }),
    // Another key order still counts, through the ordinary parse.
    JSON.stringify({ timestamp: at(12), type: 'api-request', id: 'r2' }),
  ].join('\n'), base)
  expect(s.activeMs).toBe(12 * 60000)
  expect(s.prompts).toBe(2)
  expect(s.project).toBe('/work/app')
})

test('a copied session counts once and a repeated line counts once', () => {
  const base = { id: 'copy', project: '', folder: '', size: 0, mtime: 0 }
  const at = (m: number) => new Date(Date.UTC(2026, 9, 29, 10, m)).toISOString()
  const said = (uuid: string, m: number, sessionId: string, content: string) => JSON.stringify({ type: 'user', uuid, sessionId, timestamp: at(m), cwd: '/work/app', message: { role: 'user', content } })
  const call = (uuid: string, m: number, sessionId: string, id: string) => JSON.stringify({ type: 'assistant', uuid, sessionId, timestamp: at(m), message: { id, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t-${id}`, name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 1, output_tokens: 10 } } })
  const s = parseLog([
    said('u1', 0, 'orig', 'the old prompt'),
    call('a1', 1, 'orig', 'm1'),
    JSON.stringify({ type: 'cost-state', sessionId: 'orig', totalCostUSD: 458 }),
    `{"type":"api-request","sessionId":"orig","id":"r1","timestamp":"${at(2)}"}`,
    said('u2', 100, 'copy', 'the new prompt'),
    call('a2', 101, 'copy', 'm2'),
    call('a2', 101, 'copy', 'm2'),
    said('u2', 100, 'copy', 'the new prompt'),
    `{"type":"api-request","sessionId":"copy","id":"r2","timestamp":"${at(103)}"}`,
  ].join('\n'), base)
  expect(s.prompts).toBe(1)
  expect(s.firstPrompt).toBe('the new prompt')
  expect(s.calls).toBe(1)
  expect(s.out).toBe(10)
  expect(s.usd).toBeUndefined()
  expect(s.start).toBe(Date.UTC(2026, 9, 29, 10, 100))
  expect(s.activeMs).toBe(3 * 60000)

  const onlyCopied = parseLog([said('u1', 0, 'orig', 'x'), call('a1', 1, 'orig', 'm1')].join('\n'), base)
  expect([onlyCopied.prompts, onlyCopied.calls, onlyCopied.replies]).toEqual([0, 0, 0])
})

test('time and cost go to the days they happened on', () => {
  const base = { id: 's', project: '', folder: '', size: 0, mtime: 0 }
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString()
  const key = (d: number) => dayKey(new Date(2026, 9, d).getTime())
  const mark = (t: string, uuid: string) => JSON.stringify({ type: 'user', uuid, sessionId: 's', timestamp: t, message: { role: 'user', content: 'go' } })
  const cost = (usd: number, sessionId = 's') => JSON.stringify({ type: 'cost-state', sessionId, totalCostUSD: usd })
  const s = parseLog([
    cost(400, 'orig'),
    mark(at(30, 23, 50), 'a'), mark(at(30, 23, 54), 'b'), cost(401), mark(at(30, 23, 58), 'c'),
    mark(at(31, 0, 2), 'd'), mark(at(31, 0, 4), 'e'), cost(403.5),
  ].join('\n'), base)
  expect(s.usd).toBe(3.5)
  expect(s.activeMs).toBe(14 * 60000)
  expect(s.days).toEqual({ [key(30)]: { ms: 8 * 60000, usd: 1 }, [key(31)]: { ms: 6 * 60000, usd: 2.5 } })

  // A summary from before days were counted stands on the day it started.
  const old = { ...s, days: undefined, start: new Date(2026, 9, 30, 12).getTime() }
  expect(daysOf(old)).toEqual({ [key(30)]: { ms: s.activeMs, usd: 3.5 } })
  expect(sinceDay([s, old], new Date(2026, 9, 31, 12).getTime())).toEqual({ ms: 6 * 60000, usd: 2.5 })
  expect(msPerDay([s, old]).get(key(30))).toBe(8 * 60000 + s.activeMs)
})
