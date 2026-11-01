import { expect, test } from 'claude-code/testing'
import type { HistSession } from '../types'
import { SCAN_KEY } from '../hooks/history'
import { maskSession } from '../hooks/privacy'

const past = (id: string): HistSession => ({
  id, project: '/clients/SECRETPROJ', folder: '-clients-SECRETPROJ', size: 1, mtime: 1, start: Date.UTC(2026, 9, 31, 7), end: Date.UTC(2026, 9, 31, 8), activeMs: 600000,
  prompts: 2, commands: 0, replies: 2, calls: 4, errors: 1, out: 200, inp: 10, cr: 30, cw: 5, models: { 'claude-opus-5-5': 3 },
  tools: { Bash: 2, mcp__SECRETSERVER__get: 2 }, toolErr: { mcp__SECRETSERVER__get: 1 }, subMsgs: 0,
  linesAdded: 7, linesRemoved: 1, commits: 1, prs: 0, rejections: 0, interrupts: 0, compactions: 0, apiErrors: 0, retryMs: 0, errKinds: { other: 1 },
  subOut: 0, subIn: 0, subCalls: 0, usd: 2.5, branch: 'SECRETBRANCH', firstPrompt: 'SECRETPROMPT in the first message',
  branches: { SECRETBRANCH: { ms: 600000, usd: 2.5, prompts: 2, end: Date.UTC(2026, 9, 31, 8) } },
  days: { '2026-10-31': { ms: 600000, usd: 2.5 } },
})

test('an alias stays the same, and two names stay two', () => {
  const a = maskSession(past('a'))
  const b = maskSession({ ...past('b'), project: '/clients/OTHER' })
  expect(a.project).toBe(maskSession(past('c')).project)
  expect(a.project).not.toBe(b.project)
  expect(a.project).toMatch(/^project-[0-9a-z]{4}$/)
  expect(a.firstPrompt).toBeUndefined()
  expect(Object.keys(a.tools)).toContain('Bash')
})

test('no report, pane or band shows a real name in privacy mode, and they do without it', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  const kv = new Map<string, unknown>([[SCAN_KEY, { at: t, dir: '/Users/SECRETUSER/.claude/projects', sessions: [past('a'), past('b')], skipped: 0 }]])
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/clients/SECRETPROJ' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 200000, percent: 1 }, cost: { usd: 1 }, rateLimits: [] } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => e as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, isError: true, text: 'nope', ref: 'r' }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await $.prompt.submit({ text: 'SECRETPROMPT typed now' } as never)
  await $.turn.start({ text: 'SECRETPROMPT typed now', turnId: 't1' })
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'mcp__SECRETSERVER__get' } as never)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 60000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)

  const everything = async () => {
    const out: string[] = []
    for (const args of ['', 'history', 'all', 'project', 'search SECRE', 'search 10-31']) out.push((await $.command.run({ command: 'dashboard', args } as never)).text)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const band = await $.ui.mount({ plugin: 'session-dash', component: 'AbovePrompt', surface, props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as never)
      out.push(JSON.stringify(await band.findAll({})))
      await band.unmount()
      const pane = await $.ui.mount({ plugin: 'session-dash', component: 'Pane', requestId: 'session-dash', surface, props: { bodyColumns: 120, scroll: { offset: 0, bodyRows: 200 } } } as never)
      out.push(JSON.stringify(await pane.findAll({})))
      await pane.press({ key: 'details' }).catch(() => undefined)
      out.push(JSON.stringify(await pane.findAll({})))
      await pane.press({ key: 'tab-history' })
      out.push(JSON.stringify(await pane.findAll({})))
      await pane.press({ key: 'scope-all' })
      out.push(JSON.stringify(await pane.findAll({})))
      await pane.press({ key: 'tab-session' })
      await pane.unmount()
    }
    return out.join('\n')
  }

  // Without privacy mode the same drawings do show them: the search below can find a leak.
  const open = await everything()
  for (const name of ['SECRETPROJ', 'SECRETBRANCH', 'SECRETPROMPT', 'SECRETSERVER', 'SECRETUSER']) expect([name, open.includes(name)]).toEqual([name, true])

  expect((await $.command.run({ command: 'dashboard', args: 'private on' } as never)).text).toContain('Privacy mode on')
  const hidden = await everything()
  expect(hidden.match(/.{0,40}SECRET.{0,40}/)?.[0]).toBeUndefined()
  // The search reads the aliases too: a real name finds nothing, so the result says nothing about it.
  expect(hidden).toContain('Search "SECRE": 0 of 2 sessions')
  expect(hidden).toContain('project-')
  expect(hidden).toContain('branch-')
  expect(hidden).toContain('Private: on')

  // The button turns it off again, and the choice stays in the store.
  const pane = await $.ui.mount({ plugin: 'session-dash', component: 'Pane', requestId: 'session-dash', surface: 'vscode', props: { bodyColumns: 120, scroll: { offset: 0, bodyRows: 200 } } } as never)
  await pane.press({ key: 'private' })
  await new Promise(r => setTimeout(r, 20))
  expect(kv.get('private')).toBe(false)
  await pane.unmount()
})
