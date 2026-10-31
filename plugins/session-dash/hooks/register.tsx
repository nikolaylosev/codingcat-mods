import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CallRow, HistScan, HistSession, PastSession, Stats, ToolStat, TurnRow } from '../types'
import { bigPending, loadScan, projectName, readBigLogs, readingBig, scan } from './history'

const PANE = 'session-dash'
const TITLE = 'Session dashboard'
const empty = (): Stats => ({ startedAt: 0, turns: [], tools: [], recent: [], prompts: 0 })
const stats = atom({ plugin: 'session-dash', key: 'stats' } as const, empty(), { shape: 'stats-1' })

const fmtN = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`
const fmtMs = (ms: number) =>
  ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
const bar = (v: number, max: number, w: number) => {
  const n = max > 0 ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * w)) : 0
  return '█'.repeat(n) + '·'.repeat(Math.max(0, w - n))
}
const SPARK = '▁▂▃▄▅▆▇█'
const spark = (vals: number[]) => {
  const max = Math.max(1, ...vals)
  return vals.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}
const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

function summarize(s: Stats, usd?: number): PastSession {
  const main = s.turns
  const inTot = main.reduce((a, t) => a + t.inp + t.cacheRead + t.cacheWrite, 0)
  return {
    startedAt: s.startedAt,
    turns: main.filter(t => !t.isSub).length,
    toolCalls: s.tools.reduce((a, t) => a + t.count, 0),
    errors: s.tools.reduce((a, t) => a + t.errors, 0),
    outTokens: main.reduce((a, t) => a + t.out, 0),
    activeMs: main.filter(t => !t.isSub).reduce((a, t) => a + t.ms, 0),
    cacheHit: pct(main.reduce((a, t) => a + t.cacheRead, 0), inTot),
    usd,
  }
}

const pad = (v: string | number, n: number) => String(v).padStart(n)
const padR = (v: string, n: number) => (v.length > n ? v.slice(0, n - 1) + '…' : v.padEnd(n))
const two = (n: number) => String(n).padStart(2, '0')
// Local time of the machine the session runs on.
const clock = (t: number) => {
  const d = new Date(t)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
const day = (t: number) => {
  const d = new Date(t)
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(t)}`
}
const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
const DAY = 24 * 3600 * 1000

type Agg = { n: number; prompts: number; calls: number; errors: number; out: number; activeMs: number; usd: number; hasUsd: boolean }
const agg = (list: HistSession[]): Agg =>
  list.reduce<Agg>(
    (a, x) => ({
      n: a.n + 1,
      prompts: a.prompts + x.prompts,
      calls: a.calls + x.calls,
      errors: a.errors + x.errors,
      out: a.out + x.out,
      activeMs: a.activeMs + x.activeMs,
      usd: a.usd + (x.usd ?? 0),
      hasUsd: a.hasUsd || x.usd !== undefined,
    }),
    { n: 0, prompts: 0, calls: 0, errors: 0, out: 0, activeMs: 0, usd: 0, hasUsd: false },
  )
const merge = (list: HistSession[], f: (x: HistSession) => Record<string, number>) => {
  const r: Record<string, number> = {}
  for (const x of list) for (const [k, v] of Object.entries(f(x))) r[k] = (r[k] ?? 0) + v
  return Object.entries(r).sort((a, b) => b[1] - a[1])
}

function historyReport(h: HistScan, currentId: string | undefined, now: number, detailed: boolean): string {
  const L: string[] = []
  const hr = (title: string) => L.push('', `── ${title} ${'─'.repeat(Math.max(3, 44 - title.length))}`)
  const all = h.sessions.filter(x => x.id !== currentId && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0))
  const projects = new Set(all.map(projectName))
  hr(`All sessions · ${all.length} in ${projects.size} projects`)
  if (h.error) L.push(`  ${h.error}`)
  if (!all.length) {
    L.push(h.at ? '  No past sessions found in the logs.' : '  Reading the logs… run /dashboard again in a moment.')
    return L.join('\n')
  }
  const startOfToday = new Date(new Date(now).toDateString()).getTime()
  const cost = (a: Agg) => (a.hasUsd ? '$' + a.usd.toFixed(2) : '—')
  L.push(`  period        sess  prompts  calls  err%     out    active     cost`)
  for (const [label, since] of [['today', startOfToday], ['7 days', now - 7 * DAY], ['30 days', now - 30 * DAY], ['all', 0]] as const) {
    const a = agg(all.filter(x => x.end >= since))
    L.push(`  ${padR(label, 12)} ${pad(a.n, 5)} ${pad(a.prompts, 8)} ${pad(a.calls, 6)} ${pad(pct(a.errors, a.calls) + '%', 5)} ${pad(fmtN(a.out), 7)} ${pad(fmtMs(a.activeMs), 9)} ${pad(cost(a), 8)}`)
  }

  const days: number[] = []
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(now - i * DAY)
    days.push(all.filter(x => dayKey(x.start) === k).reduce((a, x) => a + x.activeMs, 0))
  }
  L.push('', `  active / day (30d)  ${spark(days)}  today ${fmtMs(days[days.length - 1] ?? 0)}`)

  const recent = [...all].sort((a, b) => b.end - a.end).slice(0, detailed ? 15 : 6)
  hr('Recent sessions')
  L.push(`  started      project           prompts calls err     out   active    cost`)
  for (const x of recent)
    L.push(`  ${day(x.start)}  ${padR(projectName(x), 16)} ${pad(x.prompts, 6)} ${pad(x.calls, 5)} ${pad(x.errors || '·', 3)} ${pad(fmtN(x.out), 7)} ${pad(fmtMs(x.activeMs), 8)} ${pad(x.usd !== undefined ? '$' + x.usd.toFixed(2) : '—', 7)}`)

  if (detailed) {
    hr('By project')
    const byP = new Map<string, HistSession[]>()
    for (const x of all) byP.set(projectName(x), [...(byP.get(projectName(x)) ?? []), x])
    const rows = [...byP.entries()].map(([k, v]) => [k, agg(v)] as const).sort((a, b) => b[1].activeMs - a[1].activeMs)
    const maxA = Math.max(1, ...rows.map(r => r[1].activeMs))
    L.push(`  project           sess  active              calls  err%     out     cost`)
    for (const [k, a] of rows.slice(0, 12))
      L.push(`  ${padR(k, 16)} ${pad(a.n, 5)}  ${bar(a.activeMs, maxA, 10)} ${pad(fmtMs(a.activeMs), 7)} ${pad(a.calls, 6)} ${pad(pct(a.errors, a.calls) + '%', 5)} ${pad(fmtN(a.out), 7)} ${pad(cost(a), 8)}`)

    hr('Tools across sessions')
    const tools = merge(all, x => x.tools)
    const errs = Object.fromEntries(merge(all, x => x.toolErr))
    const totalCalls = tools.reduce((a, t) => a + t[1], 0)
    const maxT = Math.max(1, ...tools.map(t => t[1]))
    L.push(`  tool                calls  share            err  err%`)
    for (const [k, v] of tools.slice(0, 15))
      L.push(`  ${padR(k, 18)} ${pad(v, 6)}  ${bar(v, maxT, 12)} ${pad(pct(v, totalCalls) + '%', 3)} ${pad(errs[k] ?? '·', 4)} ${pad(errs[k] ? pct(errs[k] ?? 0, v) + '%' : '', 5)}`)
    const worst = Object.entries(errs).filter(([k]) => k !== 'unknown').map(([k, e]) => [k, e, pct(e, tools.find(t => t[0] === k)?.[1] ?? 0)] as const).filter(r => r[1] >= 3).sort((a, b) => b[2] - a[2]).slice(0, 3)
    if (worst.length) L.push('', `  Most error-prone: ${worst.map(([k, e, p]) => `${k} ${p}% (${e})`).join(' · ')}`)

    hr('Models')
    const models = merge(all, x => x.models)
    const totM = models.reduce((a, m) => a + m[1], 0)
    for (const [k, v] of models.slice(0, 6)) L.push(`  ${padR(k, 28)} ${pad(pct(v, totM) + '%', 4)}  ${bar(v, totM, 16)}`)

    hr('When you work')
    const hours = Array.from({ length: 24 }, () => 0)
    for (const x of all) hours[new Date(x.start).getHours()] = (hours[new Date(x.start).getHours()] ?? 0) + x.activeMs
    L.push(`  ${spark(hours)}`)
    L.push(`  0     6     12    18   23`)
    const wk = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    const wd = Array.from({ length: 7 }, () => 0)
    for (const x of all) wd[new Date(x.start).getDay()] = (wd[new Date(x.start).getDay()] ?? 0) + x.activeMs
    L.push(`  ${[1, 2, 3, 4, 5, 6, 0].map(i => `${wk[i]} ${spark([wd[i] ?? 0, Math.max(...wd)]).slice(0, 1)}`).join('  ')}`)

    const a = agg(all)
    hr('Habits')
    L.push(`  avg session      ${fmtMs(a.activeMs / all.length)} active · ${(a.prompts / all.length).toFixed(1)} prompts · ${(a.calls / all.length).toFixed(1)} calls`)
    L.push(`  calls per prompt ${(a.calls / Math.max(1, a.prompts)).toFixed(1)}   out tokens per prompt ${fmtN(a.out / Math.max(1, a.prompts))}`)
    const inT = all.reduce((s2, x) => s2 + x.inp + x.cr + x.cw, 0)
    L.push(`  cache hit        ${pct(all.reduce((s2, x) => s2 + x.cr, 0), inT)}%   subagent messages ${all.reduce((s2, x) => s2 + x.subMsgs, 0)}`)
    const longest = [...all].sort((p, q) => q.activeMs - p.activeMs)[0]
    if (longest) L.push(`  longest          ${fmtMs(longest.activeMs)} · ${projectName(longest)} · ${day(longest.start)}`)
  }
  const big = bigPending(h)
  const bigRead = h.sessions.filter(x => x.big && !x.tooBig).length
  const failed = h.sessions.filter(x => x.failed).length
  const bigNote = big
    ? ` · ${big} large logs ${readingBig() ? 'being read in the background' : 'not read yet'}`
    : bigRead ? ` · ${bigRead} large logs read` : ''
  L.push('', `  logs: ${h.dir || '?'} · scanned ${h.at ? ago(now, h.at) + ' ago' : 'never'}${bigNote}${failed ? ` · ${failed} unreadable` : ''}${h.total && h.total > h.sessions.length ? ` · newest ${h.sessions.length} of ${h.total}` : ''}`)
  if (!detailed) L.push('  /dashboard history — projects, tools, models, habits · /dashboard scan — re-read logs')
  return L.join('\n')
}

function textReport(
  s: Stats,
  usd: number | undefined,
  ctx: { percent?: number; tokens?: number; window: number },
  past: PastSession[],
  now: number,
): string {
  const c = summarize(s, usd)
  const main = s.turns.filter(t => !t.isSub)
  const subs = s.turns.filter(t => t.isSub)
  const L: string[] = []
  const hr = (title: string) => L.push('', `── ${title} ${'─'.repeat(Math.max(3, 44 - title.length))}`)

  const durs = main.map(t => t.ms).sort((x, y) => x - y)
  const median = durs.length ? durs[Math.floor(durs.length / 2)] ?? 0 : 0
  const longest = main.reduce<TurnRow | undefined>((m, t) => (!m || t.ms > m.ms ? t : m), undefined)
  const toolMs = s.tools.reduce((a, t) => a + t.ms, 0)
  const denied = s.tools.reduce((a, t) => a + t.denied, 0)
  const aborted = main.filter(t => t.reason === 'aborted').length
  const failed = main.filter(t => t.reason === 'error' || t.reason === 'refusal').length
  const span = s.startedAt ? now - s.startedAt : 0

  L.push(`SESSION DASHBOARD · started ${s.startedAt ? clock(s.startedAt) : '?'} (${s.startedAt ? ago(now, s.startedAt) : '?'} ago) · now ${clock(now)}`)

  hr('Overview')
  L.push(`  Prompts        ${pad(s.prompts, 8)}     Turns (main)   ${pad(main.length, 8)}`)
  L.push(`  Subagent runs  ${pad(subs.length, 8)}     Interrupted    ${pad(aborted, 8)}`)
  L.push(`  Failed turns   ${pad(failed, 8)}     Tool calls     ${pad(c.toolCalls, 8)}`)
  L.push(`  Tool errors    ${pad(`${c.errors} (${pct(c.errors, c.toolCalls)}%)`, 8)}     Denied         ${pad(denied, 8)}`)
  if (usd !== undefined) L.push(`  Cost           ${pad('$' + usd.toFixed(2), 8)}     per turn       ${pad(main.length ? '$' + (usd / main.length).toFixed(2) : '—', 8)}`)

  hr('Time')
  L.push(`  Wall clock     ${pad(fmtMs(span), 8)}     Model working  ${pad(fmtMs(c.activeMs), 8)} (${Math.min(100, pct(c.activeMs, span))}%)`)
  L.push(`  Avg turn       ${pad(fmtMs(main.length ? c.activeMs / main.length : 0), 8)}     Median turn    ${pad(fmtMs(median), 8)}`)
  L.push(`  In tools       ${pad(fmtMs(toolMs), 8)}     share of work  ${pad(pct(toolMs, c.activeMs) + '%', 8)}`)
  if (longest) L.push(`  Longest turn   ${pad(fmtMs(longest.ms), 8)}     "${padR(longest.prompt ?? '(continuation)', 30).trim()}"`)

  const sum = (f: (t: TurnRow) => number) => s.turns.reduce((a, t) => a + f(t), 0)
  const inp = sum(t => t.inp), cr = sum(t => t.cacheRead), cw = sum(t => t.cacheWrite), out = sum(t => t.out)
  const inTot = inp + cr + cw
  hr('Tokens & cache')
  L.push(`  Output         ${pad(fmtN(out), 8)}     avg/turn       ${pad(fmtN(main.length ? out / main.length : 0), 8)}`)
  L.push(`  Input total    ${pad(fmtN(inTot), 8)}`)
  L.push(`    cache read   ${pad(fmtN(cr), 8)}  ${bar(cr, inTot, 20)} ${pct(cr, inTot)}%`)
  L.push(`    cache write  ${pad(fmtN(cw), 8)}  ${bar(cw, inTot, 20)} ${pct(cw, inTot)}%`)
  L.push(`    uncached     ${pad(fmtN(inp), 8)}  ${bar(inp, inTot, 20)} ${pct(inp, inTot)}%`)
  if (ctx.percent !== undefined)
    L.push(`  Context        ${bar(ctx.percent, 100, 20)} ${ctx.percent}%  (${fmtN(ctx.tokens ?? 0)} / ${fmtN(ctx.window)})`)
  const models = [...new Set(s.turns.map(t => t.model).filter((m): m is string => !!m))]
  if (models.length) L.push(`  Models         ${models.join(', ')}`)

  if (main.length > 1) {
    const last = main.slice(-40)
    hr(`Trends (last ${last.length} turns)`)
    L.push(`  duration  ${spark(last.map(t => t.ms))}`)
    L.push(`  output    ${spark(last.map(t => t.out))}`)
    L.push(`  tools     ${spark(last.map(t => t.calls ?? 0))}`)
  }

  if (main.length) {
    hr('Turns (latest first)')
    L.push(`   #  time   dur      out  calls err  end      prompt`)
    const n0 = main.length
    main.slice(-12).reverse().forEach((t, i) => {
      L.push(
        `  ${pad(n0 - i, 2)}  ${t.at ? clock(t.at) : '  —  '} ${pad(fmtMs(t.ms), 6)} ${pad(fmtN(t.out), 7)} ${pad(t.calls ?? '—', 6)} ${pad(t.errs ?? '—', 3)}  ${padR(t.reason, 7)}  ${padR(t.prompt || '(continuation)', 34)}`,
      )
    })
  }

  const tools = [...s.tools].sort((a, b) => b.count - a.count)
  if (tools.length) {
    const max = Math.max(1, ...tools.map(t => t.count))
    hr('Tools')
    L.push(`  tool            calls  share                 avg     total   err  deny`)
    for (const t of tools.slice(0, 15))
      L.push(
        `  ${padR(t.name, 14)} ${pad(t.count, 6)}  ${bar(t.count, max, 14)} ${pad(pct(t.count, c.toolCalls) + '%', 4)} ${pad(fmtMs(t.ms / Math.max(1, t.count)), 7)} ${pad(fmtMs(t.ms), 8)} ${pad(t.errors || '·', 4)} ${pad(t.denied || '·', 5)}`,
      )
    const slow = [...s.recent].filter(r => r.status !== 'run').sort((x, y) => y.ms - x.ms).slice(0, 3)
    if (slow.length) L.push('', `  Slowest recent: ${slow.map(r => `${r.tool} ${fmtMs(r.ms)}`).join(' · ')}`)
  }

  if (s.recent.length) {
    hr('Recent calls')
    for (const r of s.recent.slice(-12).reverse()) {
      const mark = r.status === 'ok' ? '✓' : r.status === 'err' ? '✗' : r.status === 'deny' ? '⊘' : '…'
      L.push(`  ${mark} ${clock(r.at)}  ${padR(r.tool, 22)} ${pad(r.status === 'run' ? 'running' : fmtMs(r.ms), 8)}`)
    }
  }

  if (subs.length) {
    hr('Subagents')
    L.push(`  runs ${subs.length} · time ${fmtMs(subs.reduce((a, t) => a + t.ms, 0))} · output ${fmtN(subs.reduce((a, t) => a + t.out, 0))}`)
  }

  return L.join('\n')
}

type Ui = { ui: { open: (a: { id: string; title: string }) => Promise<{ isPlaced: boolean }>; status: (t: string | undefined) => void } }

async function ensureOpen($: Ui) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  return r.isPlaced
}

async function refreshStatus($: Parameters<typeof read>[0]) {
  const s = await read($, stats)
  const c = summarize(s)
  ;($ as unknown as Ui).ui.status(
    c.turns || c.toolCalls
      ? `◆ ${c.turns}t · ${fmtMs(c.activeMs)} · ${c.toolCalls} calls · ${c.errors} err · cache ${c.cacheHit}% · /dashboard`
      : undefined,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, stats, s => (s.startedAt ? s : { ...empty(), startedAt: now }))
    await $.command.register({ name: 'dash', description: 'Show a detailed dashboard of this session' })
    await $.command.register({ name: 'dashboard', description: 'Session dashboard; "history" for all past sessions, "scan" to re-read logs' })
    void ensureOpen($)
    void refreshStatus($)
    // Read the logs, then the large ones by streaming, after the session is up.
    void (async () => {
      await scan($).catch(() => undefined)
      await readBigLogs($).catch(() => undefined)
    })()
    return next(e)
  })

  // The app often attaches after the session started: open the pane again then.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    void ensureOpen($)
    return r
  }).catch(($, e, next) => next(e))

  for (const command of ['dash', 'dashboard'] as const) {
    on('command.run', { command }, async ($, e) => {
      const arg = e.args.trim().toLowerCase()
      const now = await $.clock.now()
      const id = await $.session.id().catch(() => undefined)
      if (arg === 'history' || arg === 'all' || arg === 'scan') {
        const h = await scan($, { force: arg === 'scan' })
        if (bigPending(h) && !readingBig()) $.clock.after(10, () => void readBigLogs($).catch(() => undefined))
        const note = bigPending(h) ? `\n\n  ${bigPending(h)} large logs are being read in the background: run /dashboard history again in a minute or two.` : ''
        return { text: historyReport(h, id, now, true).replace(/^\n/, '') + note }
      }
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      const s = await read($, stats)
      const usage = await $.session.usage()
      const h = await scan($).catch(() => loadScan($))
      const report = textReport(s, usage.cost?.usd, usage.context, [], now) + '\n' + historyReport(h, id, now, false)
      return { text: opened.isPlaced ? `(also open in a side pane)\n\n${report}` : report }
    }).catch(() => ({ text: 'session-dash: the dashboard failed to open.' }))
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, stats)
    if (s.turns.length === 0 && s.recent.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const c = summarize(s)
    return (
      <Box flexDirection="row">
        <Text dimColor>
          ◆ {c.turns} turns · {fmtMs(c.activeMs)} · {c.toolCalls} calls ·{' '}
        </Text>
        <Text color={c.errors ? 'red' : 'green'}>{c.errors} err</Text>
        <Text dimColor> · {fmtN(c.outTokens)} out · cache {c.cacheHit}% · /dashboard</Text>
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, stats, s => ({ ...s, prompts: s.prompts + 1 }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `${e.tool}-${Math.random()}`
    const t0 = await $.clock.now()
    await update($, stats, s => ({
      ...s,
      recent: [...s.recent, { id, tool: e.tool, at: t0, ms: 0, status: 'run' as const }].slice(-40),
    }))
    const ran = await next(e)
    const ms = (await $.clock.now()) - t0
    const status: CallRow['status'] = ran.deny !== undefined ? 'deny' : ran.isError ? 'err' : 'ok'
    await update($, stats, s => {
      const tools: ToolStat[] = s.tools.some(t => t.name === e.tool)
        ? s.tools.map(t => (t.name === e.tool ? t : t))
        : [...s.tools, { name: e.tool, count: 0, errors: 0, denied: 0, ms: 0 }]
      return {
        ...s,
        tools: tools.map(t =>
          t.name === e.tool
            ? {
                ...t,
                count: t.count + 1,
                errors: t.errors + (status === 'err' ? 1 : 0),
                denied: t.denied + (status === 'deny' ? 1 : 0),
                ms: t.ms + ms,
              }
            : t,
        ),
        recent: s.recent.map(r => (r.id === id ? { ...r, ms, status } : r)),
        pending:
          e.agentId === undefined && s.pending
            ? { ...s.pending, calls: s.pending.calls + 1, errs: s.pending.errs + (status === 'err' ? 1 : 0) }
            : s.pending,
      }
    })
    void refreshStatus($)
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined)
      await update($, stats, s => ({ ...s, pending: { calls: 0, errs: 0, prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 80) } }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const u = e.usage
    const row: TurnRow = {
      id: e.turnId,
      ms: e.durationMs,
      out: u?.output_tokens ?? 0,
      inp: u?.input_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
      reason: e.reason,
      isSub: e.agentId !== undefined,
      tools: 0,
      at: await $.clock.now(),
      model: u?.model,
    }
    await update($, stats, s => {
      const p = !row.isSub ? s.pending : undefined
      const full: TurnRow = p ? { ...row, calls: p.calls, errs: p.errs, prompt: p.prompt } : row
      return { ...s, turns: [...s.turns, full].slice(-300), pending: row.isSub ? s.pending : undefined }
    })
    void refreshStatus($)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, stats)
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const logs = await loadScan($)
    const myId = await $.session.id().catch(() => undefined)
    const past = logs.sessions
      .filter(x => x.id !== myId && !x.tooBig && (x.prompts > 0 || x.calls > 0))
      .sort((a, b) => b.end - a.end)
    const week = past.filter(x => x.end >= now - 7 * DAY)
    const wk = agg(week)
    const cols = Math.max(30, (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 60)
    const barW = Math.max(6, Math.min(24, cols - 30))

    const mainTurns = s.turns.filter(t => !t.isSub)
    const subTurns = s.turns.length - mainTurns.length
    const cur = summarize(s, usage.cost?.usd)
    const totalCalls = cur.toolCalls
    const denied = s.tools.reduce((a, t) => a + t.denied, 0)
    const avgTurn = mainTurns.length ? cur.activeMs / mainTurns.length : 0
    const aborted = mainTurns.filter(t => t.reason === 'aborted').length
    const failed = mainTurns.filter(t => t.reason === 'error' || t.reason === 'refusal').length
    const inTot = s.turns.reduce((a, t) => a + t.inp + t.cacheRead + t.cacheWrite, 0)
    const tools = [...s.tools].sort((a, b) => b.count - a.count).slice(0, 10)
    const maxCount = Math.max(1, ...tools.map(t => t.count))
    const room = Math.max(3, Math.min(10, (e.viewport?.rows ?? 40) - 34))
    const recent = s.recent.slice(-room).reverse()
    const ctxPct = usage.context.percent

    const Kpi = (p: { label: string; value: string; hint?: string; color?: string }) => (
      <Box flexDirection="column" marginRight={2} marginBottom={1}>
        <Text dimColor size="caption">{p.label}</Text>
        <Text bold size="heading" color={p.color}>{p.value}</Text>
        {p.hint !== undefined && <Text dimColor size="caption">{p.hint}</Text>}
      </Box>
    )
    const H = (p: { t: string }) => (
      <Box marginTop={1}><Text bold color="cyan">{p.t}</Text></Box>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>
          started {s.startedAt ? ago(now, s.startedAt) : '?'} ago · {s.prompts} prompts
        </Text>

        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          <Kpi label="Turns" value={`${mainTurns.length}`} hint={subTurns ? `+${subTurns} subagent` : 'main loop'} />
          <Kpi label="Active time" value={fmtMs(cur.activeMs)} hint={`avg ${fmtMs(avgTurn)}/turn`} />
          <Kpi label="Tool calls" value={`${totalCalls}`} hint={mainTurns.length ? `${(totalCalls / mainTurns.length).toFixed(1)}/turn` : '—'} />
          <Kpi
            label="Errors"
            value={`${cur.errors}`}
            hint={`${pct(cur.errors, totalCalls)}% · ${denied} denied`}
            color={cur.errors > 0 ? 'red' : 'green'}
          />
          <Kpi label="Output tok" value={fmtN(cur.outTokens)} hint={`in ${fmtN(inTot)}`} />
          <Kpi label="Cache hit" value={`${cur.cacheHit}%`} color={cur.cacheHit >= 70 ? 'green' : 'yellow'} />
          {usage.cost && <Kpi label="Cost" value={`$${usage.cost.usd.toFixed(2)}`} />}
          {ctxPct !== undefined && (
            <Kpi label="Context" value={`${ctxPct}%`} hint={`of ${fmtN(usage.context.window)}`} color={ctxPct > 80 ? 'red' : ctxPct > 60 ? 'yellow' : undefined} />
          )}
        </Box>

        {(aborted > 0 || failed > 0) && (
          <Text color="yellow">⚠ {aborted} interrupted · {failed} failed turns</Text>
        )}

        {mainTurns.length > 1 && (
          <Box flexDirection="column">
            <H t="Turn duration" />
            <Text color="magenta">{spark(mainTurns.slice(-(cols - 2)).map(t => t.ms))}</Text>
            <H t="Output tokens per turn" />
            <Text color="blue">{spark(mainTurns.slice(-(cols - 2)).map(t => t.out))}</Text>
          </Box>
        )}

        <H t="Tools" />
        {tools.length === 0 && <Text dimColor>No tool calls yet.</Text>}
        {tools.map(t => (
          <Text key={t.name}>
            {t.name.slice(0, 14).padEnd(14)} <Text color="cyan">{bar(t.count, maxCount, barW)}</Text> {String(t.count).padStart(3)}
            <Text dimColor> {fmtMs(t.ms / Math.max(1, t.count))}</Text>
            {t.errors > 0 && <Text color="red"> ✗{t.errors}</Text>}
          </Text>
        ))}

        <H t="Recent calls" />
        {recent.length === 0 && <Text dimColor>—</Text>}
        {recent.map(r => (
          <Text key={r.id} dimColor={r.status === 'ok'}>
            <Text color={r.status === 'err' ? 'red' : r.status === 'deny' ? 'yellow' : r.status === 'run' ? 'cyan' : undefined}>
              {r.status === 'ok' ? '✓' : r.status === 'err' ? '✗' : r.status === 'deny' ? '⊘' : '…'}
            </Text>{' '}
            {r.tool.slice(0, 28)} <Text dimColor>{r.status === 'run' ? 'running' : fmtMs(r.ms)} · {ago(now, r.at)} ago</Text>
          </Text>
        ))}

        <H t="All sessions (from logs)" />
        {past.length === 0 && <Text dimColor>{logs.at ? 'No past sessions found.' : 'Reading logs…'}</Text>}
        {past.length > 0 && (
          <Text>
            7 days: {wk.n} sessions · {fmtMs(wk.activeMs)} · {wk.calls} calls ·{' '}
            <Text color={wk.errors ? 'red' : undefined}>{pct(wk.errors, wk.calls)}% err</Text>
            {wk.hasUsd && <Text dimColor> · ${wk.usd.toFixed(2)}</Text>}
          </Text>
        )}
        {past.slice(0, 6).map(x => (
          <Box key={x.id}>
            <Text>
              <Text dimColor>{day(x.start)}</Text> {projectName(x).slice(0, 16)} · {x.prompts}p · {x.calls} calls ·{' '}
              <Text color={x.errors ? 'red' : undefined}>{x.errors} err</Text> · {fmtMs(x.activeMs)}
            </Text>
          </Box>
        ))}
        {past.length > 0 && <Text dimColor>/dashboard history for projects, tools, habits</Text>}

        <Box flexDirection="row" marginTop={1}>
          <Button
            key="reset"
            label="Reset this session's stats"
            onPress={() => {
              void $.clock.now().then(t => update($, stats, () => ({ ...empty(), startedAt: t })))
            }}
          />
        </Box>
      </Box>
    )
  })
}
