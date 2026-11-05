import { expect, test } from 'claude-code/testing'
import { donutSvg } from '../hooks/charts'
import { limitView } from '../hooks/limits'

test('a call that auto mode or the person stopped is a denial, not a failure of the tool', async ($, on) => {
  let t = Date.UTC(2026, 10, 5, 12, 0)
  const kv = new Map<string, unknown>()
  on('clock.now', () => ({ value: (t += 1000) }))
  on('store.get', (_, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 'current' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 1 }, rateLimits: [] } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    const file = String((e as { file_path?: string }).file_path)
    if (file === '/auto') return { result: {}, isError: true, text: 'The server-side auto mode classifier gave no verdict', ref: 'r' } as never
    if (file === '/no') return { result: {}, isError: true, text: "The user doesn't want to proceed with this tool use.", ref: 'r' } as never
    if (file === '/gone') return { result: {}, isError: true, text: 'File does not exist.', ref: 'r' } as never
    return { result: {} }
  })

  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  for (const file of ['/auto', '/auto', '/auto', '/no', '/ok', '/ok'])
    await $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' } as never)
  const stopped = (await $.command.run({ command: 'session-dash', args: '' } as never)).text
  expect(stopped).not.toContain('Edit failed')
  expect(stopped).toContain('3 tool calls denied')
  expect(stopped).toMatch(/Tool errors\s+0 \(0%\)\s+Denied\s+4/)

  // A real failure still counts as one.
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Edit', file_path: '/gone', old_string: 'a', new_string: 'b' } as never)
  const failed = (await $.command.run({ command: 'session-dash', args: '' } as never)).text
  expect(failed).toContain('Edit failed 4 of 10 calls')
})

const near = (value: number | undefined, want: number, within: number) => expect(Math.abs((value ?? NaN) - want)).toBeLessThan(within)

test('the week\'s pace counts nights and days off, and a fast week still runs out', () => {
  const now = Date.UTC(2026, 10, 5, 18, 40)
  const resetsAt = new Date(Date.UTC(2026, 10, 7, 18, 0)).toISOString()
  const at = (hoursAgo: number, pct: number) => ({ t: now - hoursAgo * 3600000, kind: 'seven_day', pct, resetsAt })

  // Readings from the last hour and a half of work only: 62% to 64%. The window started
  // 5 days 40 minutes ago, so its own pace is far slower, and it lasts until the reset.
  const burst = limitView([{ kind: 'seven_day', percentUsed: 64, resetsAt }], [at(1.4, 62), at(1.3, 63)], now)[0]
  expect(burst?.runsOut).toBe(false)
  near(burst?.ratePerHour, 64 / (5 * 24 + 40 / 60), 0.001)

  // A reading a day old: the rise since then is the pace.
  const day = limitView([{ kind: 'seven_day', percentUsed: 80, resetsAt }], [at(30, 40), at(25, 50), at(2, 78)], now)[0]
  near(day?.ratePerHour, 30 / 25, 0.001)
  expect(day?.runsOut).toBe(true)

  // The 5-hour window still goes by its last hour.
  const five = limitView([{ kind: 'five_hour', percentUsed: 31, resetsAt }], [{ t: now - 3 * 3600000, kind: 'five_hour', pct: 1, resetsAt }, { t: now - 50 * 60000, kind: 'five_hour', pct: 18, resetsAt }], now)[0]
  near(five?.ratePerHour, 13 / (50 / 60), 0.1)
})

test('a long figure in a donut gets smaller, a short one keeps its size', () => {
  const size = (center: string) => Number(donutSvg([{ label: 'a', value: 1 }], { size: 104, center, caption: 'tokens' }).match(/font-size="(\d+)" font-weight="600"/)?.[1])
  expect(size('377')).toBe(21)
  expect(size('120.0M')).toBeLessThan(21)
  // Six characters fit in the hole with room on each side.
  expect(size('120.0M') * 6 * 0.62).toBeLessThanOrEqual((104 - 2 * 17) * 0.8)
})
