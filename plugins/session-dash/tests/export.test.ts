import { expect, test } from 'claude-code/testing'
import type { HistSession } from '../types'
import { exportTables, toCsv } from '../hooks/export'
import { SCAN_KEY } from '../hooks/history'

const session = (id: string, project: string, extra: Partial<HistSession> = {}): HistSession => ({
  id, project, folder: '-x', size: 1, mtime: 1, start: Date.UTC(2026, 9, 29, 10), end: Date.UTC(2026, 9, 30, 10), activeMs: 600000,
  prompts: 2, commands: 0, replies: 2, calls: 4, errors: 1, out: 200, inp: 10, cr: 30, cw: 5, models: { 'claude-opus-5-5': 3 }, tools: {}, toolErr: {}, subMsgs: 0,
  linesAdded: 7, linesRemoved: 1, commits: 1, prs: 0, rejections: 0, interrupts: 0, compactions: 0, apiErrors: 0, retryMs: 0, errKinds: { 'command not found': 1 },
  subOut: 0, subIn: 0, subCalls: 0, usd: 2.5, branch: 'main',
  days: { '2026-10-29': { ms: 240000, usd: 1 }, '2026-10-30': { ms: 360000, usd: 1.5 } },
  branches: { main: { ms: 600000, usd: 2.5, prompts: 2, commits: 1, added: 7, removed: 1, end: Date.UTC(2026, 9, 30, 10) } },
  ...extra,
})

test('the tables add up, per session, day, project, branch and model', () => {
  const t = exportTables([session('a', '/work/app'), session('b', '/work/app'), session('c', '/work/lib', { usd: undefined, days: { '2026-10-29': { ms: 60000 } } })])
  expect(t.sessions?.length).toBe(3)
  expect(t.sessions?.[0]?.errors_command_not_found).toBe(1)
  expect(t.sessions?.[2]?.api_eq_usd).toBeUndefined()
  expect(t.days?.find(r => r.date === '2026-10-29' && r.project === '/work/app')).toEqual({ date: '2026-10-29', project: '/work/app', active_min: 8, api_eq_usd: 2 })
  const app = t.projects?.find(r => r.project === '/work/app')
  expect([app?.sessions, app?.prompts, app?.api_eq_usd, app?.tokens_out, app?.active_min]).toEqual([2, 4, 5, 400, 20])
  expect(t.branches?.find(r => r.project === 'app')?.sessions).toBe(2)
  expect(t.models).toEqual([{ model: 'claude-opus-5-5', messages: 9, sessions: 3 }])
})

test('a cell cannot break the table or run as a formula', () => {
  const csv = toCsv([{ name: 'a,b', say: 'he said "x"', f: '=SUM("A1")', g: '-1+1', n: -1.5, none: undefined }, { name: 'plain', extra: 'late' }])
  expect(csv).toBe('name,say,f,g,n,none,extra\n"a,b","he said ""x""","\'=SUM(""A1"")",\'-1+1,-1.5,,\nplain,,,,,,late\n')
})

test('/dashboard export writes every table to the folder named, under aliases in privacy mode', async ($, on) => {
  const written = new Map<string, string>()
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: Date.UTC(2026, 9, 31, 9, 0), dir: '/p', sessions: [session('a', '/work/SECRETPROJ', { firstPrompt: 'SECRETPROMPT', branch: 'SECRETBRANCH', branches: { SECRETBRANCH: { ms: 1, end: 1 } } })], skipped: 0 }]])
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 31, 9, 1) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('fs.write', (_, e) => { written.set(e.path, e.text); return { value: undefined } })
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/work/SECRETPROJ' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 1 }, cost: { usd: 0 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const run = async (args: string) => (await $.command.run({ command: 'dashboard', args } as never)).text

  expect(await run('export')).toContain('Usage')
  const plain = await run('export csv /tmp/My Exports')
  expect(plain).toContain('/tmp/My Exports/session-dash-sessions.csv')
  expect([...written.keys()].sort()).toEqual(['branches', 'days', 'models', 'projects', 'sessions'].map(n => `/tmp/My Exports/session-dash-${n}.csv`))
  expect(written.get('/tmp/My Exports/session-dash-sessions.csv')).toContain('/work/SECRETPROJ')

  written.clear()
  await run('private on')
  await run('export json')
  expect(written.size).toBe(5)
  for (const [path, text] of written) {
    expect(path.startsWith('/work/SECRETPROJ/session-dash-export/')).toBe(true)
    expect(text).not.toContain('SECRET')
  }
  expect(JSON.parse(written.get('/work/SECRETPROJ/session-dash-export/session-dash-projects.json') ?? '[]')[0].project).toMatch(/^project-/)
})

test('the export buttons write the files and say where, without the real path in privacy mode', async ($, on) => {
  const written = new Map<string, string>()
  const toasts: string[] = []
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: Date.UTC(2026, 9, 31, 9, 0), dir: '/p', sessions: [session('a', '/work/SECRETPROJ')], skipped: 0 }]])
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 31, 9, 1) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('fs.write', (_, e) => { written.set(e.path, e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/work/SECRETPROJ' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 1 }, cost: { usd: 0 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 40 && !ready(); i++) await new Promise(r => setTimeout(r, 25))
  }

  const pane = await $.ui.mount({ plugin: 'session-dash', component: 'Pane', requestId: 'session-dash', surface: 'vscode', props: { bodyColumns: 120, scroll: { offset: 0, bodyRows: 200 } } } as never)
  await pane.press({ key: 'tab-history' })
  await pane.press({ key: 'export-csv' })
  await until(() => toasts.length === 1)
  expect(written.has('/work/SECRETPROJ/session-dash-export/session-dash-sessions.csv')).toBe(true)
  expect(toasts[0]).toBe('Exported 1 sessions: /work/SECRETPROJ/session-dash-export')

  written.clear()
  await $.command.run({ command: 'dashboard', args: 'private on' } as never)
  await pane.press({ key: 'export-json' })
  await until(() => toasts.length === 2)
  expect(written.has('/work/SECRETPROJ/session-dash-export/session-dash-models.json')).toBe(true)
  expect(toasts[1]).toBe('Exported 1 sessions: <project>/session-dash-export')
  const reply = (await $.command.run({ command: 'dashboard', args: 'export csv' } as never)).text
  expect(reply).toContain('<project>/session-dash-export/session-dash-sessions.csv')
  expect(reply).not.toContain('SECRET')
  await pane.unmount()
})
