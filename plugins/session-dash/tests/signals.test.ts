import { expect, test } from 'claude-code/testing'
import { classifyError, denyKind, isCommit } from '../hooks/signals'

const ts = (m: number) => new Date(Date.UTC(2026, 9, 30, 10, m)).toISOString()
const main = [
  { type: 'user', cwd: '/work/alpha', timestamp: ts(0), message: { role: 'user', content: 'ship it' } },
  { type: 'assistant', timestamp: ts(1), message: { id: 'a1', model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git commit -m "x"' } },
    { type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'gh pr create --fill' } },
    { type: 'tool_use', id: 'c3', name: 'Bash', input: { command: 'jq .' } },
    { type: 'tool_use', id: 'c4', name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b\nc' } },
  ], usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
  { type: 'user', timestamp: ts(2), message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'c1', content: '[main 1a2b] x' },
    { type: 'tool_result', tool_use_id: 'c2', content: 'https://github.com/o/r/pull/1' },
    { type: 'tool_result', tool_use_id: 'c3', is_error: true, content: 'bash: jq: command not found' },
    { type: 'tool_result', tool_use_id: 'c4', is_error: true, content: "The user doesn't want to proceed with this tool use." },
  ] } },
  { type: 'user', timestamp: ts(3), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  { type: 'system', subtype: 'compact_boundary', timestamp: ts(4) },
  { type: 'cost-state', totalCostUSD: 1, totalLinesAdded: 120, totalLinesRemoved: 30, totalAPIDuration: 9000, totalAPIDurationWithoutRetries: 6000 },
].map(o => JSON.stringify(o)).join('\n')
const sub = [
  { type: 'assistant', isSidechain: true, timestamp: ts(2), message: { id: 's1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'g', name: 'Grep', input: {} }], usage: { input_tokens: 0, output_tokens: 500, cache_read_input_tokens: 4500, cache_creation_input_tokens: 0 } } },
].map(o => JSON.stringify(o)).join('\n')

test('lines, commits, PRs, trouble signals, error kinds, subagents and plan limits', async ($, on) => {
  let t = Date.UTC(2026, 9, 31, 9, 0)
  let pct5 = 40
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: t }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/nick' : undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) => ({
    value: e.path.endsWith('/projects') ? [{ name: '-work-alpha', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : e.path.endsWith('/subagents') ? [{ name: 'agent-1.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }]
      : [{ name: 's1.jsonl', kind: 'file', size: 10, mtimeMs: 1, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: e.path.includes('/subagents/') ? sub : main }))
  on('session.id', () => ({ value: 'current' }))
  on('session.root', () => ({ value: '/work/alpha' }))
  on('session.usage', () => ({ value: {
    startedAt: 0, context: { window: 200000, percent: 20 }, cost: { usd: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: pct5, resetsAt: new Date(Date.UTC(2026, 9, 31, 12, 0)).toISOString() }, { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(Date.UTC(2026, 10, 4)).toISOString() }],
  } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => (e.tool === 'Bash' && String((e as { command?: string }).command).includes('nope') ? ({ result: {}, isError: true, text: 'nope: command not found', ref: 'r' } as never) : { result: {} }))

  await $.session.start({ cwd: '/work/alpha', surface: null, isInteractive: true })
  // This session: an edit, a commit, three missing commands.
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'x', new_string: 'y\nz\nw' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "fix"' } as never)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'nope' } as never)
  // The 5-hour window climbs 40% → 70% in 30 minutes: 60%/h, full in 30m, resets in 3h.
  t += 30 * 60 * 1000
  pct5 = 70
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)

  const now = (await $.command.run({ command: 'dashboard', args: '' } as never)).text
  console.log(now.split('\n').slice(0, 16).join('\n'))
  expect(now).toContain('Plan limits')
  expect(now).toMatch(/5-hour limit 70%: at this pace full in 30m/)
  expect(now).toContain('Output: +3 −1 lines · 1 commits')
  expect(now).toContain('3 errors: command not found')

  const hist = (await $.command.run({ command: 'dashboard', args: 'history' } as never)).text
  console.log(hist.split('\n').filter(l => /Output|lines|commits|rejected|interrupt|compaction|retries|command not found|subagents|tip/.test(l)).join('\n'))
  expect(hist).toContain('+120 −30 lines · 1 commits · 1 PRs')
  expect(hist).toMatch(/1 rejected · 1 interrupted · 1 compactions/)
  expect(hist).toContain('3.0s lost to retries')
  expect(hist).toMatch(/command not found\s+1/)
  expect(hist).toMatch(/subagents 5\.0k tokens/)

  const PANE = { plugin: 'session-dash', component: 'Pane', requestId: 'session-dash',
    props: { title: 'Session dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } } as const
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    await ui.press({ key: 'tab-session' })
    expect(await ui.find({ type: 'Text', text: /Plan limits/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /5-hour/ })).toBeTruthy()
    await ui.press({ key: 'details' })
    expect(await ui.find({ type: 'Text', text: /Errors by type/ })).toBeTruthy()
    await ui.press({ key: 'tab-history' })
    expect(await ui.find({ type: 'Text', text: /Trouble signals/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Main vs subagents/ })).toBeTruthy()
    await ui.press({ key: 'tab-session' })
    await ui.press({ key: 'details' }) // fold the details back for the next surface
    await ui.unmount()
  }
})

test('a commit is the git subcommand, not a word in another command', () => {
  for (const yes of ['git commit -m "x"', 'cd a && git commit -am "x; y"', 'git -C /repo commit -m x', 'git -c a.b=c --no-pager commit', 'A=1 git commit --amend', "git add . && git commit -F - <<'EOF'\nmsg\nEOF", 'git log --grep commit; git commit', 'if [ -n "$x" ]; then git commit -m y; fi', '! git commit -m y'])
    expect([yes, isCommit(yes)]).toEqual([yes, true])
  for (const no of ['git log --grep commit', 'git add commit.txt', 'git show commit', 'git commit --dry-run', 'echo git commit', 'git commit-tree abc', 'grep -r "git commit" .'])
    expect([no, isCommit(no)]).toEqual([no, false])
})

test('errors are told apart by who stopped the call and what the command printed', () => {
  expect(classifyError("The user doesn't want to proceed with this tool use.")).toBe('rejected')
  expect(classifyError('Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Git Destructive].')).toBe('denied')
  expect(classifyError('Permission for this command was denied by a built-in Claude Code safety check, not by the user.')).toBe('denied')
  expect(classifyError('The server-side auto mode classifier gave no verdict')).toBe('denied')
  expect(classifyError('<tool_use_error>Blocked: sleep 240 followed by: grep -E "^(PASS|FAIL)|passed" e2e.log')).toBe('denied')
  expect(classifyError('bash: /etc/x: Permission denied')).toBe('permission')
  expect(classifyError('Exit code 1\nTraceback (most recent call last):\n  File "a.py"')).toBe('script error')
  expect(classifyError('Exit code 1\nfile:3\nTypeError: x is not a function')).toBe('script error')
  expect(classifyError('Exit code 1\n')).toBe('no output')
  expect(classifyError('Exit code 1\nsome listing')).toBe('non-zero exit')
  expect(denyKind('blocked by my hook')).toBe('denied')
  expect(denyKind("The user doesn't want to proceed")).toBe('rejected')
})
