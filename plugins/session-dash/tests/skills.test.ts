import { expect, test } from 'claude-code/testing'
import { parseLog, SCAN_KEY } from '../hooks/history'
import { maskSession } from '../hooks/privacy'
import { historyReport } from '../hooks/report'
import { skillList, skillRows } from '../hooks/skills'

const base = { id: 'x', project: '/work/app', folder: 'app', size: 0, mtime: 0 }
const at = (m: number) => new Date(Date.UTC(2026, 9, 29, 10, m)).toISOString()
const text = 'Base directory for this skill: /home/me/.claude/skills/writing\n\n' + 'x'.repeat(3936)
const reply = (id: string, content: unknown[] = []) => ({ type: 'assistant', timestamp: at(1), message: { id, model: 'claude-opus-5-5', content } })
const call = (id: string, skill: string) => ({ type: 'tool_use', id, name: 'Skill', input: { skill } })
const result = (id: string, isError = false) => ({ type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } })
const body = (id: string | undefined, content: string) => ({ type: 'user', isMeta: true, sourceToolUseID: id, timestamp: at(2), message: { role: 'user', content: [{ type: 'text', text: content }] } })
const log = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n')

test('a skill counts its uses, its size and the requests that read it again', () => {
  const s = parseLog(log([
    { type: 'attachment', timestamp: at(0), attachment: { type: 'skill_listing', isInitial: true, content: 'y'.repeat(800) } },
    reply('m1', [call('a', 'my-plugin:writing')]),
    result('a'),
    body('a', text),
    reply('m2'),
    reply('m3'),
  ]), base)
  const size = text.length
  expect(s.skills?.['my-plugin:writing']).toEqual({ uses: 1, chars: size, charCost: Math.round(size * 1.45) })
  expect(s.listChars).toBe(800)
  expect(s.listCost).toBe(Math.round(800 * 1.55))
  const [row] = skillRows([s])
  expect(row?.tokens).toBe(Math.round(size / 4))
  expect(row?.sessions).toBe(1)
  expect(skillList([s])).toEqual({ sessions: 1, tokens: 200, cost: 310 })
})

test('a refused call is no use, and a skill run by its slash command is one', () => {
  const s = parseLog(log([
    reply('m1', [call('a', 'refused')]),
    result('a', true),
    body(undefined, text),
    reply('m2'),
  ]), base)
  expect(s.skills?.refused).toBeUndefined()
  expect(s.skills?.writing?.uses).toBe(1)
  expect(s.prompts).toBe(0)
})

test('a skill that puts no text in the log has no size to guess', () => {
  const s = parseLog(log([reply('m1', [call('a', 'forked')]), result('a')]), base)
  expect(s.skills?.forked).toEqual({ uses: 1, chars: 0, charCost: 0 })
  expect(skillRows([s])[0]?.tokens).toBe(0)
})

test('sessions without skills carry nothing, and privacy mode hides the names', () => {
  const none = parseLog(log([reply('m1')]), base)
  expect(none.skills).toBeUndefined()
  expect(skillRows([none])).toEqual([])
  expect(skillList([none])).toBeUndefined()

  const s = parseLog(log([reply('m1', [call('a', 'client-acme')]), result('a')]), base)
  const shown = Object.keys(maskSession(s).skills ?? {})
  expect(shown.length).toBe(1)
  expect(shown[0]).not.toContain('acme')
  expect(shown[0]).toStartWith('skill-')
})

test('the report names skills and says its figures are estimates', () => {
  const s = parseLog(log([reply('m1', [call('a', 'writing')]), result('a'), body('a', text), reply('m2')]), base)
  const report = historyReport({ at: 1, dir: '', skipped: 0, sessions: [s] }, undefined, Date.UTC(2026, 9, 30), true)
  expect(report).toContain('Skills (estimates)')
  expect(report).toContain('writing')
  expect(report).toContain('full-price input tokens')
})

const seeded = (sessions: unknown[]) => new Map<string, unknown>([[SCAN_KEY, { at: Date.UTC(2026, 9, 31), dir: '/p', sessions, skipped: 0 }]])
const PANE = {
  plugin: 'session-dash', component: 'Pane', requestId: 'session-dash',
  props: { title: 'Session dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the History tab shows skills on every surface, and leaves them out when there are none', async ($, on) => {
  const used = parseLog(log([
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'go' } },
    { type: 'attachment', timestamp: at(0), attachment: { type: 'skill_listing', isInitial: true, content: 'y'.repeat(800) } },
    reply('m1', [call('a', 'writing')]),
    result('a'),
    body('a', text),
    reply('m2'),
  ]), base)
  let kv = seeded([used])
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 31) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('session.id', () => ({ value: 'current' }))
  on('fs.exists', () => ({ value: false }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 200000, percent: 1 }, rateLimits: [], cost: { usd: 0 } } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-history' })
    expect(await ui.find({ type: 'Text', text: /^Skills/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /writing/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /List of skills/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /full-price input tokens/ })).toBeTruthy()
    await ui.press({ key: 'tab-session' })
    await ui.unmount()
  }
  kv = seeded([{ ...used, skills: undefined, listChars: undefined, listCost: undefined }])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await ui.find({ type: 'Text', text: /List of skills/ })).toBeFalsy()
  await ui.unmount()
})

test("a subagent's skills join its session's", async ($, on) => {
  const main = log([
    { type: 'user', sessionId: 's1', timestamp: at(0), message: { role: 'user', content: 'go' } },
    reply('m1', [call('a', 'writing')]),
    result('a'),
    body('a', text),
  ])
  const sub = log([
    { ...reply('s1', [call('b', 'writing')]), isSidechain: true },
    { ...result('b'), isSidechain: true },
    { ...body('b', text), isSidechain: true },
    { ...reply('s2'), isSidechain: true },
  ])
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 31) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/subagents') ? [{ name: 'agent-1.jsonl', kind: 'file', size: sub.length, mtimeMs: 3, isLink: false }]
      : e.path.endsWith('/projects') ? [{ name: '-work-app', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : [{ name: 's1.jsonl', kind: 'file', size: main.length, mtimeMs: 5, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('agent-1.jsonl') ? sub : main }))
  on('session.id', () => ({ value: 'current' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await $.command.run({ command: 'session-dash', args: 'scan' } as never)
  const scan = kv.get(SCAN_KEY) as { sessions: { skills?: Record<string, { uses: number; charCost: number }> }[] }
  const size = text.length
  expect(scan.sessions[0]?.skills?.writing?.uses).toBe(2)
  // The main copy has no later reply, and the subagent's has one.
  expect(scan.sessions[0]?.skills?.writing?.charCost).toBe(Math.round(size * 1.25) + Math.round(size * 1.35))
})
