import { expect, test } from 'claude-code/testing'
import type { DayCounts, HistScan, HistSession } from '../types'
import { countsOf, dayKey, within } from '../hooks/days'
import { BIG_LEASE_KEY, newerSummary, parseLog, SCAN_KEY } from '../hooks/history'
import { weekAndBefore } from '../hooks/insights'
import { classifyError } from '../hooks/signals'
import { aggSince } from '../hooks/state'

// Local noon on two days, so that the lines fall on those days in any time zone.
const DAY1 = new Date(2026, 10, 5, 12, 0).getTime()
const DAY2 = new Date(2026, 10, 6, 12, 0).getTime()
const iso = (t: number, m = 0) => new Date(t + m * 60000).toISOString()
const usage = (out: number) => ({ input_tokens: 1, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 })
const prompt = (t: number) => ({ type: 'user', cwd: '/work/demo', timestamp: iso(t), message: { role: 'user', content: 'go' } })
const reply = (t: number, id: string, out: number, name: string, input: unknown = {}) =>
  ({ type: 'assistant', timestamp: iso(t, 1), message: { id, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t-${id}`, name, input }], usage: usage(out) } })
const result = (t: number, id: string, text = 'ok', isError = false) =>
  ({ type: 'user', timestamp: iso(t, 2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${id}`, is_error: isError, content: text }] } })
const text = (xs: unknown[]) => xs.map(o => JSON.stringify(o)).join('\n')
const base = { id: 's', project: '', folder: '', size: 1, mtime: 1 }

const twoDays = text([
  prompt(DAY1), reply(DAY1, 'a', 100, 'Read'), result(DAY1, 'a'),
  { type: 'cost-state', totalCostUSD: 1, totalLinesAdded: 5, totalLinesRemoved: 1, totalAPIDuration: 100, totalAPIDurationWithoutRetries: 90 },
  prompt(DAY2), prompt(DAY2),
  reply(DAY2, 'b', 300, 'Bash', { command: 'make' }), result(DAY2, 'b', "The user doesn't want to proceed", true),
  reply(DAY2, 'c', 50, 'Bash', { command: 'git commit -m x' }), result(DAY2, 'c'),
  { type: 'system', subtype: 'compact_boundary', timestamp: iso(DAY2, 3) },
  { type: 'user', timestamp: iso(DAY2, 4), message: { role: 'user', content: '[Request interrupted by user]' } },
  { type: 'cost-state', totalCostUSD: 3, totalLinesAdded: 9, totalLinesRemoved: 2, totalAPIDuration: 200, totalAPIDurationWithoutRetries: 170 },
])

test('a session counts what it did on each day, and the days add up to the session', () => {
  const x = parseLog(twoDays, base)
  const one = x.counts?.[dayKey(DAY1)]
  const two = x.counts?.[dayKey(DAY2)]
  expect(one).toEqual({ prompts: 1, calls: 1, out: 100, inp: 1, cr: 10, cw: 2, added: 5, removed: 1, retryMs: 10 })
  expect(two).toEqual({ prompts: 2, calls: 2, errors: 1, rejections: 1, commits: 1, out: 350, inp: 2, cr: 20, cw: 4, added: 4, removed: 1, retryMs: 20, compactions: 1, interrupts: 1 })

  const sum = (k: keyof DayCounts) => (one?.[k] ?? 0) + (two?.[k] ?? 0)
  expect([sum('prompts'), sum('calls'), sum('errors'), sum('out'), sum('commits')]).toEqual([x.prompts, x.calls, x.errors, x.out, x.commits])
  expect([sum('added'), sum('removed'), sum('retryMs'), sum('compactions')]).toEqual([x.linesAdded, x.linesRemoved, x.retryMs, x.compactions])
})

test('a period counts only its own days', () => {
  const x = parseLog(twoDays, base)
  const second = within(x, dayKey(DAY2))
  expect([second.prompts, second.calls, second.out, second.usd]).toEqual([2, 2, 350, 2])
  const first = within(x, dayKey(DAY1), dayKey(DAY2))
  expect([first.prompts, first.calls, first.out, first.usd]).toEqual([1, 1, 100, 1])

  const today = aggSince([x], new Date(2026, 10, 6, 0, 0).getTime())
  expect([today.n, today.prompts, today.calls, today.errors, today.out, today.usd]).toEqual([1, 2, 2, 1, 350, 2])
  const all = aggSince([x], 0)
  expect([all.prompts, all.calls, all.out, all.usd]).toEqual([3, 3, 450, 3])
})

test('a summary kept from before counts per day has them all on its last day', () => {
  const { counts: _counts, ...old } = parseLog(twoDays, base)
  expect(countsOf(old)[dayKey(old.end)]?.prompts).toBe(3)
  expect(within(old, dayKey(DAY2)).prompts).toBe(3)
  expect(within(old, dayKey(DAY1), dayKey(DAY2)).prompts).toBe(0)
})

test('the week and the weeks before it each get their share of a long session', () => {
  const now = new Date(2026, 10, 15, 12, 0).getTime()
  const x = parseLog(twoDays, base) // 10 and 9 days ago
  const later = text([prompt(now), reply(now, 'z', 70, 'Read')])
  const long = parseLog(twoDays + '\n' + later, base)

  const early = weekAndBefore([x], now)
  expect(early.week.length).toBe(0)
  expect(early.before.map(s => s.prompts)).toEqual([3])

  const both = weekAndBefore([long], now)
  expect(both.week.map(s => [s.prompts, s.out])).toEqual([[1, 70]])
  expect(both.before.map(s => [s.prompts, s.out])).toEqual([[3, 450]])
})

const LOG_DIR = '/home/nick/.claude/projects/-work-demo'
function world(on: never, kv: Map<string, unknown>, files: { name: string; size: number; mtimeMs: number }[], reads: Record<string, string>, spawned: string[], listed?: (path: string) => void) {
  const hook = on as (event: string, hook: unknown) => void
  let t = DAY2
  hook('clock.now', () => ({ value: (t += 1000) }))
  hook('store.get', (_: unknown, e: { key: string }) => ({ value: kv.get(e.key) }))
  hook('store.set', (_: unknown, e: { key: string; value: unknown }) => { kv.set(e.key, e.value); return { value: undefined } })
  hook('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/nick' : undefined }))
  hook('fs.exists', () => ({ value: true }))
  hook('fs.list', (_: unknown, e: { path: string }) => {
    listed?.(e.path)
    if (e.path.endsWith('/subagents')) return { value: reads[`${e.path}/agent.jsonl`] ? [{ name: 'agent.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }] : [] }
    if (e.path.endsWith('/projects')) return { value: [{ name: '-work-demo', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    return { value: files.map(f => ({ ...f, kind: 'file', isLink: false })) }
  })
  hook('fs.read', (_: unknown, e: { path: string }) => ({ value: reads[e.path] ?? '' }))
  hook('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    spawned.push(String(e.argv[1]))
    yield { stream: 'stdout', text: text([prompt(DAY1), reply(DAY1, 'big', 5, 'Read')]) }
    return { value: { code: 0, signal: null } }
  })
  hook('session.id', () => ({ value: 'me' }))
  hook('session.root', () => ({ value: '/work/demo' }))
  hook('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  hook('command.register', () => ({ value: { command: 'x' } }))
  hook('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}
const scanned = (kv: Map<string, unknown>, id: string) => (kv.get(SCAN_KEY) as HistScan | undefined)?.sessions.find(x => x.id === id)
const BIG = 9 * 1024 * 1024

test('the tools of a subagent count with its session, in the table and on their day', async ($, on) => {
  const kv = new Map<string, unknown>()
  const reads = {
    [`${LOG_DIR}/s.jsonl`]: text([prompt(DAY1), reply(DAY1, 'a', 10, 'Read')]),
    [`${LOG_DIR}/s/subagents/agent.jsonl`]: text([reply(DAY1, 'b', 20, 'Grep'), result(DAY1, 'b', 'Exit code 1\nboom', true), reply(DAY1, 'c', 30, 'Read')]),
  }
  world(on as never, kv, [{ name: 's.jsonl', size: 100, mtimeMs: 5 }], reads, [])
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 30))

  const x = scanned(kv, 's')
  expect(x?.tools).toEqual({ Read: 2, Grep: 1 })
  expect(x?.toolErr).toEqual({ Grep: 1 })
  const day = x?.counts?.[dayKey(DAY1)]
  expect([day?.calls, day?.errors, day?.out, day?.prompts]).toEqual([3, 1, 60, 1])
  expect([x?.calls, x?.errors, x?.out]).toEqual([3, 1, 60])
})

test('one session at a time reads the large logs, and a reader that died gives way', async ($, on) => {
  const kv = new Map<string, unknown>([[BIG_LEASE_KEY, { by: 'other', until: DAY2 + 3600000 }]])
  const spawned: string[] = []
  world(on as never, kv, [{ name: 'big.jsonl', size: BIG, mtimeMs: 7 }], {}, spawned)
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 60))
  expect(spawned).toEqual([])
  expect(scanned(kv, 'big')?.path).toBe(`${LOG_DIR}/big.jsonl`)

  kv.set(BIG_LEASE_KEY, { by: 'other', until: DAY2 - 1000 })
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: true })
  for (let i = 0; i < 40 && scanned(kv, 'big')?.path; i++) await new Promise(r => setTimeout(r, 25))
  expect(spawned).toEqual([`${LOG_DIR}/big.jsonl`])
  expect(scanned(kv, 'big')?.out).toBe(5)
  // Done with them, it holds them no longer.
  await new Promise(r => setTimeout(r, 20))
  expect(kv.get(BIG_LEASE_KEY) as { by: string; until: number }).toEqual({ by: 'me', until: 0 })
})

test('a scan does not put back what another session has just read', async ($, on) => {
  const summary = (over: Partial<HistSession>) => ({ ...parseLog(text([prompt(DAY1), reply(DAY1, 'a', 1, 'Read')]), { ...base, id: 'big', mtime: 7, size: BIG }), big: true, ...over }) as HistSession
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: 1, dir: '/home/nick/.claude/projects', skipped: 0, sessions: [summary({ path: `${LOG_DIR}/big.jsonl` })] }]])
  const spawned: string[] = []
  let saved = false
  // While this scan lists the files, the other session finishes that log and saves it.
  world(on as never, kv, [{ name: 'big.jsonl', size: BIG, mtimeMs: 7 }], {}, spawned, path => {
    if (saved || !path.endsWith('/projects')) return
    saved = true
    kv.set(SCAN_KEY, { at: 2, dir: '/home/nick/.claude/projects', skipped: 0, sessions: [summary({ out: 999 })] })
  })
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 60))
  expect(scanned(kv, 'big')?.out).toBe(999)
  expect(scanned(kv, 'big')?.path).toBeUndefined()
  expect(spawned).toEqual([])

  const old = summary({ mtime: 5 })
  const fresh = summary({ mtime: 9 })
  expect(newerSummary(old, fresh)).toBe(fresh)
  expect(newerSummary(fresh, old)).toBe(fresh)
})

test('the shell and git are told apart from a command that only exits with an error', () => {
  expect(classifyError('Exit code 1\n(eval):1: no matches found: src/*.ts')).toBe('shell error')
  expect(classifyError('Exit code 1\n(eval):21: bad math expression: operator expected')).toBe('shell error')
  expect(classifyError('Exit code 1\n(eval):1: ===== not found')).toBe('shell error')
  expect(classifyError('Exit code 2\nbash: line 3: syntax error near unexpected token')).toBe('shell error')
  expect(classifyError('Exit code 128\nfatal: not a git repository')).toBe('git error')
  expect(classifyError('Exit code 1\npull request create failed: GraphQL: No commits between main and x')).toBe('git error')
  expect(classifyError('Exit code 2\nsrc/a.ts(3,4): error TS2345: Argument of type')).toBe('script error')
  // These keep their kinds.
  expect(classifyError('Exit code 127\n(eval):1: command not found: foo')).toBe('command not found')
  expect(classifyError('Exit code 1\n(eval):4: no such file or directory: node')).toBe('missing file')
  expect(classifyError('Exit code 128\nfatal: unable to access: Could not resolve host: github.com')).toBe('network')
  expect(classifyError('Exit code 1\nzip-builder.ts')).toBe('non-zero exit')
})
