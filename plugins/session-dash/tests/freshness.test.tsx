import { expect, test } from 'claude-code/testing'
import { dayKey } from '../hooks/days'
import { parseLog, SCAN_KEY } from '../hooks/history'
import { efficiency } from '../hooks/insights'
import { agg, aggSince, isFloor, usdText } from '../hooks/state'

// Noon in local time: every line below falls on one calendar day, in any time zone.
const NOW = new Date(2026, 10, 5, 12, 0).getTime()
const at = (minutes: number) => new Date(NOW - minutes * 60000).toISOString()
const reply = (m: number, id: string) =>
  ({ type: 'assistant', timestamp: at(m), message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
const prompt = (m: number) => ({ type: 'user', cwd: '/work/demo', timestamp: at(m), message: { role: 'user', content: 'go' } })
const text = (xs: unknown[]) => xs.map(o => JSON.stringify(o)).join('\n')

// The log while its session ran, with no cost yet, and the same log after the session ended.
const running = text([prompt(30), reply(29, 'm1')])
const ended = text([prompt(30), reply(29, 'm1'), prompt(10), reply(9, 'm2'), { type: 'cost-state', totalCostUSD: 2.14 }])
const other = text([prompt(50), reply(49, 'o1'), { type: 'cost-state', totalCostUSD: 4.3 }])

const BAND = { plugin: 'session-dash', component: 'AbovePrompt', surface: 'vscode', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as const

type On = Parameters<Parameters<typeof test>[1]>[1]

/** Logs on disk, and a store with a scan from 14 seconds ago, when the last session still ran. */
function world(on: On, lastNow: string, reads: string[]) {
  let t = NOW
  const base = { project: '', folder: '-work-demo' }
  const kv = new Map<string, unknown>([[SCAN_KEY, {
    at: NOW - 14000, dir: '/home/nick/.claude/projects', skipped: 0, total: 2, withPrompts: false,
    sessions: [
      parseLog(running, { ...base, id: 'last', size: running.length, mtime: 5 }),
      parseLog(other, { ...base, id: 'other', size: other.length, mtime: 4 }),
    ],
  }]])
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [] : e.path.endsWith('/projects')
      ? [{ name: '-work-demo', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [
          { name: 'last.jsonl', kind: 'file', size: lastNow.length, mtimeMs: lastNow === running ? 5 : 6, isLink: false },
          { name: 'other.jsonl', kind: 'file', size: other.length, mtimeMs: 4, isLink: false },
        ],
  }))
  on('fs.read', (_, e) => { reads.push(e.path); return { value: e.path.includes('last') ? lastNow : other } })
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/work/demo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 1 }, rateLimits: [] } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

test('a new session reads the log of the one that just ended, though a scan ran seconds ago', async ($, on) => {
  const reads: string[] = []
  world(on, ended, reads)
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 20))

  const report = (await $.command.run({ command: 'session-dash', args: '' } as never)).text
  expect(report).toContain('$6.44')
  expect(report).not.toContain('at least this much')
  // Only the log that changed is read again.
  expect(reads.filter(p => p.endsWith('last.jsonl')).length).toBe(1)
  expect(reads.filter(p => p.endsWith('other.jsonl')).length).toBe(0)
})

test('a report and the band say when today\'s total leaves out a session with no cost', async ($, on) => {
  world(on, running, [])
  await $.session.start({ cwd: '/work/demo', surface: null, isInteractive: true })
  await new Promise(r => setTimeout(r, 20))

  const report = (await $.command.run({ command: 'session-dash', args: '' } as never)).text
  expect(report).toContain('$4.30+')
  expect(report).toContain('at least this much')

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 60000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 5, output_tokens: 900 } } as never)
  const app = await $.ui.mount(BAND as never)
  expect(await app.find({ type: 'Text', text: /\$4\.30\+/ })).toBeTruthy()
  await app.unmount()
})

const session = (id: string, usd: number | undefined, out: number) =>
  ({ id, project: '/work/demo', folder: '', size: 1, mtime: 1, start: NOW - 60000, end: NOW, prompts: 1, calls: 1, errors: 0, out, activeMs: 1000, usd, days: { [dayKey(NOW)]: { ms: 1000, usd } } }) as never

test('a total is marked only when it really leaves something out', () => {
  const whole = [session('a', 1.5, 10), session('b', 2, 10)]
  expect(usdText(agg(whole))).toBe('$3.50')
  expect(isFloor(agg(whole))).toBe(false)
  expect(efficiency(whole, NOW, dayKey).usd30Floor).toBe(false)

  const part = [session('a', 1.5, 10), session('b', undefined, 10)]
  expect(usdText(agg(part))).toBe('$1.50+')
  expect(usdText(aggSince(part, NOW - 3600000))).toBe('$1.50+')
  expect(efficiency(part, NOW, dayKey).usd30Floor).toBe(true)

  // Nothing to add up, so no total at all.
  expect(usdText(agg([session('b', undefined, 10)]))).toBe('—')
  // A session that never got a reply cost nothing, so the total is whole.
  expect(usdText(agg([session('a', 1.5, 10), session('c', undefined, 0)]))).toBe('$1.50')
})
