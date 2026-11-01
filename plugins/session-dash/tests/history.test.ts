import { expect, test } from 'claude-code/testing'
import { byBranch } from '../hooks/branches'
import { dayKey, daysOf, msPerDay, msPerHour, msPerWeekday, sinceDay } from '../hooks/days'
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

test('working hours and weekdays follow the time worked, not the start', () => {
  const base = { id: 's', project: '', folder: '', size: 0, mtime: 0 }
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString()
  const mark = (t: string, uuid: string) => JSON.stringify({ type: 'user', uuid, timestamp: t, message: { role: 'user', content: 'go' } })
  // Friday night into Saturday.
  const s = parseLog([mark(at(30, 23, 56), 'a'), mark(at(30, 23, 59), 'b'), mark(at(31, 0, 3), 'c'), mark(at(31, 0, 5), 'd')].join('\n'), base)
  expect(s.hours?.[23]).toBe(3 * 60000)
  expect(s.hours?.[0]).toBe(6 * 60000)
  expect(s.hours?.reduce((a, v) => a + v, 0)).toBe(s.activeMs)
  expect(msPerHour([s])[0]).toBe(6 * 60000)
  const week = msPerWeekday([s])
  expect(week[5]).toBe(3 * 60000)
  expect(week[6]).toBe(6 * 60000)

  // A summary from before hours were counted stands in the hour it started.
  const old = { ...s, hours: undefined, start: new Date(2026, 9, 30, 12).getTime() }
  expect(msPerHour([old])[12]).toBe(s.activeMs)
  expect(msPerHour([old])[0]).toBe(0)
})

test('a session counts its time, cost and output on the branch they happened on', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 29, 10, m)).toISOString()
  const said = (m: number, gitBranch: string | undefined, uuid: string) => JSON.stringify({ type: 'user', uuid, timestamp: at(m), gitBranch, message: { role: 'user', content: 'go' } })
  const cost = (usd: number, added: number) => JSON.stringify({ type: 'cost-state', totalCostUSD: usd, totalLinesAdded: added, totalLinesRemoved: 0 })
  const committed = (m: number, id: string, gitBranch: string) => [
    JSON.stringify({ type: 'assistant', uuid: `a${id}`, timestamp: at(m), gitBranch, message: { id: `m${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'git commit -m x' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: 'user', uuid: `u${id}`, timestamp: at(m), gitBranch, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  ].join('\n')
  const s = parseLog([
    said(0, undefined, 'a'), // before any branch is named: the first branch's
    said(2, 'fix/one', 'b'), cost(1, 10),
    committed(3, 't1', 'fix/one'),
    said(5, 'HEAD', 'c'), // a detached moment stays on the branch it was on
    said(6, 'main', 'd'), said(8, 'main', 'e'), cost(3, 25),
  ].join('\n'), { id: 's', project: '', folder: '', size: 0, mtime: 0 })
  expect(Object.keys(s.branches ?? {}).sort()).toEqual(['fix/one', 'main'])
  expect(s.branches?.['fix/one']).toEqual({ ms: 5 * 60000, usd: 1, prompts: 3, commits: 1, added: 10, end: Date.UTC(2026, 9, 29, 10, 5) })
  expect(s.branches?.main).toEqual({ ms: 3 * 60000, usd: 2, prompts: 2, added: 15, end: Date.UTC(2026, 9, 29, 10, 8) })
  expect(s.branch).toBe('main')

  const none = parseLog(said(0, undefined, 'a'), { id: 's', project: '', folder: '', size: 0, mtime: 0 })
  expect(none.branches).toBeUndefined()

  // A branch adds up over sessions; another project's of one name stays apart; an old summary has the branch it ended on.
  const old = { ...s, id: 'old', branches: undefined, branch: 'fix/one', project: '/work/app', activeMs: 1000, prompts: 1, usd: 7, commits: 2, linesAdded: 4, linesRemoved: 1, end: Date.UTC(2026, 9, 30) }
  const rows = byBranch([{ ...s, project: '/work/app' }, old, { ...s, id: 'x', project: '/work/lib', branches: { 'fix/one': { ms: 1, end: 1 } } }])
  const mine = rows.find(r => r.project === 'app' && r.branch === 'fix/one')
  expect(rows[0]).toBe(mine)
  expect([mine?.ms, mine?.usd, mine?.prompts, mine?.commits, mine?.sessions]).toEqual([5 * 60000 + 1000, 8, 4, 3, 2])
  expect(rows.filter(r => r.branch === 'fix/one').length).toBe(2)
})
