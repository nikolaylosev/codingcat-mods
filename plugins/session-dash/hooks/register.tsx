import { atom, read, update } from 'claude-code'
import type { ElementConstructor, ElementTable, EngineInterface, Register, SvgProps } from 'claude-code'
import { altOf, donutSvg, gaugeSvg, topSlices } from './charts'
import type { Slice } from './charts'

import type { CallRow, HistScan, HistSession, PastSession, Stats, ToolStat, TurnRow } from '../types'
import { compare, currentOf, efficiency, findings, levelColor, levelIcon, normOf } from './insights'
import type { Insight, Norm, PerPrompt } from './insights'
import { bigPending, loadScan, projectName, readBigLogs, readingBig, scan } from './history'

const PANE = 'session-dash'
const TITLE = 'Session dashboard'
const empty = (): Stats => ({ startedAt: 0, turns: [], tools: [], recent: [], prompts: 0 })
const stats = atom({ plugin: 'session-dash', key: 'stats' } as const, empty(), { shape: 'stats-1' })
const viewAtom = atom({ plugin: 'session-dash', key: 'view' } as const, 'session' as 'session' | 'history')
// Bumped whenever the log summaries change, so the pane redraws.
const logsVer = atom({ plugin: 'session-dash', key: 'logsVer' } as const, 0)
// Which sessions the history counts: those of the session's project, or all.
const detailsAtom = atom({ plugin: 'session-dash', key: 'details' } as const, false)
const scopeAtom = atom({ plugin: 'session-dash', key: 'scope' } as const, 'project' as 'project' | 'all')

type Scope = { scope: 'project' | 'all'; root: string }
const trimSlash = (p: string) => p.replace(/[\\/]+$/, '')
/** A session belongs to the project when it ran in its root or below it. */
const inScope = (x: HistSession, sc: Scope) => {
  if (sc.scope === 'all' || !sc.root) return true
  const root = trimSlash(sc.root)
  if (x.project) {
    const p = trimSlash(x.project)
    return p === root || p.startsWith(root + '/') || p.startsWith(root + '\\')
  }
  return x.folder === root.replace(/[^a-zA-Z0-9]/g, '-')
}
/** No known root (a host without one): every project. */
async function currentScope($: EngineInterface): Promise<Scope> {
  const root = await $.session.root().catch(() => '')
  return { scope: root ? await read($, scopeAtom) : 'all', root }
}
const rootName = (root: string) => trimSlash(root).split(/[\\/]/).pop() || root

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

function historyReport(h: HistScan, currentId: string | undefined, now: number, detailed: boolean, sc: Scope = { scope: 'all', root: '' }): string {
  const L: string[] = []
  const hr = (title: string) => L.push('', `── ${title} ${'─'.repeat(Math.max(3, 44 - title.length))}`)
  const all = h.sessions.filter(x => x.id !== currentId && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0) && inScope(x, sc))
  const projects = new Set(all.map(projectName))
  hr(sc.scope === 'project' && sc.root ? `Project ${rootName(sc.root)} · ${all.length} sessions` : `All sessions · ${all.length} in ${projects.size} projects`)
  if (h.error) L.push(`  ${h.error}`)
  if (!all.length) {
    L.push(h.at ? '  No past sessions found in the logs.' : '  Reading the logs… run /dashboard again in a moment.')
    return L.join('\n')
  }
  const startOfToday = new Date(new Date(now).toDateString()).getTime()
  const cost = (a: Agg) => (a.hasUsd ? '$' + a.usd.toFixed(2) : '—')
  L.push(`  period        sess  prompts  calls  err%     out    active  api-eq $`)
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
  L.push(`  started      project           prompts calls err     out   active  api-eq$`)
  for (const x of recent)
    L.push(`  ${day(x.start)}  ${padR(projectName(x), 16)} ${pad(x.prompts, 6)} ${pad(x.calls, 5)} ${pad(x.errors || '·', 3)} ${pad(fmtN(x.out), 7)} ${pad(fmtMs(x.activeMs), 8)} ${pad(x.usd !== undefined ? '$' + x.usd.toFixed(2) : '—', 7)}`)

  if (detailed) {
    const ef = efficiency(all, now, dayKey)
    hr('API-equivalent cost & efficiency · per prompt, 7d vs 3 weeks before')
    L.push('  API-equivalent: Claude Code\'s own figure at API list prices, not what a subscription bills')
    const w = ef.week, b = ef.before
    const ln = (label: string, wv: number | undefined, bv: number | undefined, fmt: (v: number) => string) => {
      if (wv === undefined) return
      const c = bv !== undefined ? compare(wv, bv) : undefined
      L.push(`  ${padR(label, 14)} ${pad(fmt(wv), 8)}  ${c && c.arrow ? `${c.arrow} ${c.arrow === '≈' ? 'as before' : c.label}` : ''}${bv !== undefined ? `  (before ${fmt(bv)})` : ''}`)
    }
    if (!w) L.push('  no sessions in the last 7 days')
    else {
      if (ef.hasCost) ln('cost', w.usd, b?.usd, v => '$' + v.toFixed(2))
      ln('model time', w.activeMs, b?.activeMs, fmtMs)
      ln('tool calls', w.calls, b?.calls, v => v.toFixed(1))
      ln('output tokens', w.out, b?.out, fmtN)
      ln('errors', w.errRate * 100, b ? b.errRate * 100 : undefined, v => Math.round(v) + '%')
    }
    if (ef.hasCost && ef.usd30 > 0) {
      L.push('', `  $ per day (30d)  ${spark(ef.usdPerDay)}`)
      L.push(`  30 days $${ef.usd30.toFixed(2)} · ${ef.activeDays} active days · $${(ef.usd30 / Math.max(1, ef.activeDays)).toFixed(2)} per active day`)
    }
    if (ef.costly.length) {
      L.push('', '  most expensive (API-equivalent):')
      for (const { s: x, usdPerPrompt } of ef.costly)
        L.push(`  ${pad('$' + (x.usd ?? 0).toFixed(2), 8)}  ${day(x.start)}  ${padR(projectName(x), 16)} ${x.prompts}p${usdPerPrompt !== undefined ? ` · $${usdPerPrompt.toFixed(2)}/prompt` : ''}`)
    }
    hr('By project')
    const byP = new Map<string, HistSession[]>()
    for (const x of all) byP.set(projectName(x), [...(byP.get(projectName(x)) ?? []), x])
    const rows = [...byP.entries()].map(([k, v]) => [k, agg(v)] as const).sort((a, b) => b[1].activeMs - a[1].activeMs)
    const maxA = Math.max(1, ...rows.map(r => r[1].activeMs))
    L.push(`  project           sess  active              calls  err%     out  api-eq $`)
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
  L.push(sc.scope === 'project' ? '  showing this project only · /dashboard all — every project' : '  showing every project · /dashboard project — this project only')
  return L.join('\n')
}

function textReport(
  s: Stats,
  usd: number | undefined,
  ctx: { percent?: number; tokens?: number; window: number },
  past: PastSession[],
  now: number,
  extra?: { notes: Insight[]; cur?: PerPrompt; norm?: Norm },
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

  if (extra && extra.notes.length) {
    hr('What stands out')
    for (const n of extra.notes) {
      L.push(`  ${levelIcon(n.level)} ${n.text}`)
      if (n.tip) L.push(`      ${n.tip}`)
    }
  }
  if (extra?.cur) {
    const { cur, norm } = extra
    hr(norm ? `Per prompt vs your norm (${norm.sessions} sessions${norm.isAllProjects ? ', all projects' : ''})` : 'Per prompt')
    const ln = (label: string, v: number, n: number | undefined, fmt: (x: number) => string) => {
      const c = n !== undefined ? compare(v, n) : undefined
      L.push(`  ${padR(label, 14)} ${pad(fmt(v), 8)}  ${c && c.arrow ? `${c.arrow} ${c.label}` : ''}${n !== undefined ? `  (usual ${fmt(n)})` : ''}`)
    }
    if (cur.usd !== undefined) ln('API-eq. cost', cur.usd, norm?.usd, v => '$' + v.toFixed(2))
    ln('model time', cur.activeMs, norm?.activeMs, fmtMs)
    ln('tool calls', cur.calls, norm?.calls, v => v.toFixed(1))
    ln('output tokens', cur.out, norm?.out, fmtN)
    if (cur.calls > 0) ln('errors', cur.errRate * 100, norm ? norm.errRate * 100 : undefined, v => Math.round(v) + '%')
  }
  hr('Overview')
  L.push(`  Prompts        ${pad(s.prompts, 8)}     Turns (main)   ${pad(main.length, 8)}`)
  L.push(`  Subagent runs  ${pad(subs.length, 8)}     Interrupted    ${pad(aborted, 8)}`)
  L.push(`  Failed turns   ${pad(failed, 8)}     Tool calls     ${pad(c.toolCalls, 8)}`)
  L.push(`  Tool errors    ${pad(`${c.errors} (${pct(c.errors, c.toolCalls)}%)`, 8)}     Denied         ${pad(denied, 8)}`)
  if (usd !== undefined) L.push(`  API-eq. cost   ${pad('$' + usd.toFixed(2), 8)}     per turn       ${pad(main.length ? '$' + (usd / main.length).toFixed(2) : '—', 8)}`)

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

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

type Pie = Slice & { note?: string }

/**
 * Charts for the surface at hand: a donut with a legend where the surface
 * draws Svg (desktop, VS Code, mobile); `hasSvg` false on the terminal, where
 * the callers keep their text bars.
 */
function chartKit(t: ElementTable) {
  const { Box, Text } = t
  const Svg = 'Svg' in t ? (t as { Svg: ElementConstructor<SvgProps> }).Svg : undefined
  const PieChart = (p: { k: string; title: string; slices: Pie[]; size?: number; center?: string; caption?: string; max?: number }) => {
    if (!Svg) return null
    const notes = new Map(p.slices.map(x => [x.label, x.note]))
    const slices = topSlices(p.slices, p.max ?? 6)
    if (!slices.length) return null
    const size = p.size ?? 104
    const total = slices.reduce((a, x) => a + x.value, 0) || 1
    return (
      <Box key={p.k} flexDirection="row" marginTop={1} alignItems="center">
        <Svg source={donutSvg(slices, { size, center: p.center, caption: p.caption })} alt={altOf(p.title, slices)} width={size} height={size} />
        <Box flexDirection="column" marginLeft={2}>
          {slices.map(x => (
            <Box key={`${p.k}-${x.label}`}>
              <Text>
                <Text color={x.color}>●</Text> {x.label.slice(0, 20)} <Text bold>{Math.round((x.value / total) * 100)}%</Text>
                {notes.get(x.label) ? <Text dimColor> {notes.get(x.label)}</Text> : null}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  }
  const Gauge = (p: { k: string; percent: number; caption: string; size?: number }) =>
    Svg ? <Svg key={p.k} source={gaugeSvg(p.percent, { size: p.size ?? 76, caption: p.caption })} alt={`${p.caption} ${p.percent}%`} width={p.size ?? 76} height={p.size ?? 76} /> : null
  return { hasSvg: !!Svg, PieChart, Gauge }
}

async function historyPane($: EngineInterface, e: RenderEvent) {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  const { hasSvg, PieChart } = chartKit(table)
  const logs = await loadScan($)
  const now = await $.clock.now()
  const myId = await $.session.id().catch(() => undefined)
  const sc = await currentScope($)
  const all = logs.sessions.filter(x => x.id !== myId && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0) && inScope(x, sc))
  const scopeBar = (
    <Box flexDirection="row" marginBottom={1}>
      <Button key="scope-project" variant={sc.scope === 'project' ? 'primary' : 'secondary'} hotkey="p" label={`This project${sc.root ? ': ' + rootName(sc.root) : ''}`}
        onPress={() => void update($, scopeAtom, () => 'project' as const)} />
      <Text> </Text>
      <Button key="scope-all" variant={sc.scope === 'all' ? 'primary' : 'secondary'} hotkey="a" label="All projects"
        onPress={() => void update($, scopeAtom, () => 'all' as const)} />
    </Box>
  )
  const cols = Math.max(30, ((e as { props?: { bodyColumns?: number } }).props?.bodyColumns) ?? 60)
  const barW = Math.max(6, Math.min(20, cols - 34))
  const name = (x: HistSession) => projectName(x)
  const H = (p: { t: string; hint?: string }) => (
    <Box marginTop={1}><Text bold color="cyan">{p.t}</Text>{p.hint && <Text dimColor>  {p.hint}</Text>}</Box>
  )
  const rescan = () => {
    void (async () => {
      await refreshLogs($ as never, true)
    })()
  }
  const pending = bigPending(logs)
  const footer = (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        {logs.at ? `scanned ${ago(now, logs.at)} ago` : 'not scanned yet'}
        {pending ? ` · ${pending} large logs ${readingBig() ? 'reading…' : 'waiting'}` : ''}
      </Text>
      <Box marginTop={1}>
        <Button key="rescan" hotkey="r" label="Re-read logs" onPress={rescan} />
      </Box>
    </Box>
  )
  if (!all.length)
    return (
      <Box flexDirection="column">
        {scopeBar}
        <Text dimColor>{!logs.at ? 'Reading the logs…' : sc.scope === 'project' ? 'No past sessions of this project yet.' : 'No past sessions found in the logs.'}</Text>
        {footer}
      </Box>
    )

  const startOfToday = new Date(new Date(now).toDateString()).getTime()
  const periods = ([['Today', startOfToday], ['7 days', now - 7 * DAY], ['30 days', now - 30 * DAY], ['All', 0]] as const).map(
    ([label, since]) => [label, agg(all.filter(x => x.end >= since))] as const,
  )
  const days: number[] = []
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(now - i * DAY)
    days.push(all.filter(x => dayKey(x.start) === k).reduce((a, x) => a + x.activeMs, 0))
  }
  const byP = new Map<string, HistSession[]>()
  for (const x of all) byP.set(name(x), [...(byP.get(name(x)) ?? []), x])
  const projects = [...byP.entries()].map(([k, v]) => [k, agg(v)] as const).sort((a, b) => b[1].activeMs - a[1].activeMs).slice(0, 8)
  const maxP = Math.max(1, ...projects.map(p => p[1].activeMs))
  const tools = merge(all, x => x.tools).slice(0, 10)
  const errs = Object.fromEntries(merge(all, x => x.toolErr))
  const maxT = Math.max(1, ...tools.map(t => t[1]))
  const models = merge(all, x => x.models).slice(0, 4)
  const totM = Math.max(1, models.reduce((a, m) => a + m[1], 0))
  const hours = Array.from({ length: 24 }, () => 0)
  for (const x of all) hours[new Date(x.start).getHours()] = (hours[new Date(x.start).getHours()] ?? 0) + x.activeMs
  const a = agg(all)
  const inT = all.reduce((t, x) => t + x.inp + x.cr + x.cw, 0)
  const recent = [...all].sort((p, q) => q.end - p.end).slice(0, 8)
  const money = (g: Agg) => (g.hasUsd ? ` · $${g.usd.toFixed(2)}` : '')

  return (
    <Box flexDirection="column">
      {scopeBar}
      <Text dimColor>{sc.scope === 'project' ? `${all.length} past sessions in ${sc.root || 'this project'}` : `${all.length} sessions in ${byP.size} projects`}</Text>

      <H t="Totals" />
      {periods.filter(([label, g]) => g.n > 0 || label === 'All').map(([label, g]) => (
        <Box key={`p-${label}`}>
          <Text>
            <Text bold>{label.padEnd(8)}</Text> {g.n} sess · {fmtMs(g.activeMs)} · {g.prompts} prompts · {g.calls} calls ·{' '}
            <Text color={g.errors ? 'red' : undefined}>{pct(g.errors, g.calls)}% err</Text>
            <Text dimColor>{money(g)}</Text>
          </Text>
        </Box>
      ))}

      {(() => {
        const ef = efficiency(all, now, dayKey)
        const w = ef.week
        const b = ef.before
        const line = (k: string, label: string, wv: number | undefined, bv: number | undefined, fmt: (v: number) => string, higherIsWorse = true) => {
          if (wv === undefined) return null
          const c = bv !== undefined ? compare(wv, bv, higherIsWorse) : undefined
          return (
            <Box key={k}>
              <Text>
                {label.padEnd(14)} <Text bold>{fmt(wv).padStart(7)}</Text>
                {c && c.arrow ? <Text color={levelColor(c.level)}> {c.arrow} {c.arrow === '≈' ? 'as before' : c.label}</Text> : null}
                {bv !== undefined ? <Text dimColor>  (before {fmt(bv)})</Text> : null}
              </Text>
            </Box>
          )
        }
        return (
          <Box flexDirection="column">
            <H t="API-equivalent cost & efficiency" />
            <Text dimColor>per prompt, last 7 days vs the 3 weeks before · $ at API list prices, not your subscription bill</Text>
            {w ? (
              <Box flexDirection="column">
                {ef.hasCost && line('e-usd', 'API-eq. cost', w.usd, b?.usd, v => `$${v.toFixed(2)}`)}
                {line('e-time', 'Model time', w.activeMs, b?.activeMs, v => fmtMs(v))}
                {line('e-calls', 'Tool calls', w.calls, b?.calls, v => v.toFixed(1))}
                {line('e-out', 'Output tokens', w.out, b?.out, v => fmtN(v))}
                {line('e-err', 'Errors', w.errRate * 100, b ? b.errRate * 100 : undefined, v => `${Math.round(v)}%`)}
              </Box>
            ) : (
              <Text dimColor>No sessions in the last 7 days.</Text>
            )}
            {ef.hasCost && ef.usd30 > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text>$ per day <Text color="yellow">{spark(ef.usdPerDay)}</Text></Text>
                <Text dimColor>
                  30 days ${ef.usd30.toFixed(2)} · {ef.activeDays} active days · ${(ef.usd30 / Math.max(1, ef.activeDays)).toFixed(2)} per active day
                </Text>
              </Box>
            )}
            {ef.costly.length > 0 && <Text bold>Most expensive sessions (API-equivalent)</Text>}
            {ef.costly.map(({ s: x, usdPerPrompt }) => (
              <Box key={`c-${x.id}`}>
                <Text>
                  <Text color="yellow">${(x.usd ?? 0).toFixed(2).padStart(6)}</Text> <Text dimColor>{day(x.start)}</Text> {projectName(x).slice(0, 14)}
                  <Text dimColor> · {x.prompts}p{usdPerPrompt !== undefined ? ` · $${usdPerPrompt.toFixed(2)}/prompt` : ''} · {fmtMs(x.activeMs)}</Text>
                </Text>
              </Box>
            ))}
            {!ef.hasCost && <Text dimColor>Cost is not recorded in these logs (older Claude Code versions).</Text>}
          </Box>
        )
      })()}

      <H t="Active time per day · 30 days" />
      <Text color="magenta">{spark(days)}</Text>
      <Text dimColor>today {fmtMs(days[days.length - 1] ?? 0)} · busiest {fmtMs(Math.max(...days))}</Text>

      {sc.scope === 'all' && <H t="Projects" hint="share of active time" />}
      {sc.scope === 'all' && hasSvg && (
        <PieChart k="pie-projects" title="Active time by project" center={fmtMs(a.activeMs)} caption="active"
          slices={[...byP.entries()].map(([k, v]) => { const g = agg(v); return { label: k, value: g.activeMs, note: `${fmtMs(g.activeMs)} · ${g.n} sess` } })} />
      )}
      {sc.scope === 'all' && hasSvg && a.hasUsd && (
        <PieChart k="pie-cost" title="API-equivalent cost by project" center={`$${Math.round(a.usd)}`} caption="API-eq."
          slices={[...byP.entries()].map(([k, v]) => { const g = agg(v); return { label: k, value: g.usd, note: `$${g.usd.toFixed(2)}` } })} />
      )}
      {sc.scope === 'all' && !hasSvg && projects.map(([k, g]) => (
        <Box key={`pr-${k}`}>
          <Text>
            {k.slice(0, 16).padEnd(16)} <Text color="cyan">{bar(g.activeMs, maxP, barW)}</Text> {fmtMs(g.activeMs)}
            <Text dimColor> · {g.n} sess · {g.calls} calls{g.errors ? '' : ''}</Text>
            {g.errors > 0 && <Text color="red"> · {pct(g.errors, g.calls)}% err</Text>}
          </Text>
        </Box>
      ))}

      <H t="Tools" hint="share of calls" />
      {hasSvg && (
        <PieChart k="pie-tools" title="Tool calls by tool" center={fmtN(a.calls)} caption="calls"
          slices={merge(all, x => x.tools).map(([k, v]) => ({ label: k, value: v, note: errs[k] ? `${v} · ✗${errs[k]}` : `${v}` }))} />
      )}
      {hasSvg && (() => {
        const inp = all.reduce((t, x) => t + x.inp, 0), cr = all.reduce((t, x) => t + x.cr, 0), cw = all.reduce((t, x) => t + x.cw, 0), o = all.reduce((t, x) => t + x.out, 0)
        return (
          <Box flexDirection="column">
            <H t="Where tokens go" />
            <PieChart k="pie-tokens" title="Tokens" center={fmtN(inp + cr + cw + o)} caption="tokens"
              slices={[
                { label: 'cache read', value: cr, color: '#10B981', note: fmtN(cr) },
                { label: 'cache write', value: cw, color: '#F59E0B', note: fmtN(cw) },
                { label: 'uncached input', value: inp, color: '#EF4444', note: fmtN(inp) },
                { label: 'output', value: o, color: '#4C8BF5', note: fmtN(o) },
              ]} />
          </Box>
        )
      })()}
      {!hasSvg && tools.map(([k, v]) => (
        <Box key={`t-${k}`}>
          <Text>
            {k.slice(0, 16).padEnd(16)} <Text color="cyan">{bar(v, maxT, barW)}</Text> {v}
            {errs[k] ? <Text color="red"> ✗{errs[k]} ({pct(errs[k] ?? 0, v)}%)</Text> : <Text> </Text>}
          </Text>
        </Box>
      ))}

      <H t="Models" hint="share of replies" />
      {hasSvg && (
        <PieChart k="pie-models" title="Replies by model" slices={merge(all, x => x.models).map(([k, v]) => ({ label: k.replace(/^claude-/, ''), value: v, note: `${v}` }))} />
      )}
      {!hasSvg && models.map(([k, v]) => (
        <Box key={`m-${k}`}>
          <Text>
            {k.slice(0, 22).padEnd(22)} <Text color="blue">{bar(v, totM, barW)}</Text> {pct(v, totM)}%
          </Text>
        </Box>
      ))}

      <H t="When you work" />
      <Text color="green">{spark(hours)}</Text>
      <Text dimColor>0h → 23h, by session start</Text>

      <H t="Habits" />
      <Text>avg session {fmtMs(a.activeMs / all.length)} · {(a.prompts / all.length).toFixed(1)} prompts · {(a.calls / all.length).toFixed(0)} calls</Text>
      <Text>{(a.calls / Math.max(1, a.prompts)).toFixed(1)} calls and {fmtN(a.out / Math.max(1, a.prompts))} out tokens per prompt</Text>
      <Text>cache hit {pct(all.reduce((t, x) => t + x.cr, 0), inT)}%</Text>

      <H t="Recent sessions" />
      {recent.map(x => (
        <Box key={`r-${x.id}`}>
          <Text>
            <Text dimColor>{day(x.start)}</Text> {name(x).slice(0, 16)} · {x.prompts}p · {x.calls} calls ·{' '}
            <Text color={x.errors ? 'red' : undefined}>{x.errors} err</Text> · {fmtMs(x.activeMs)}
            {x.usd !== undefined && <Text dimColor> · ${x.usd.toFixed(2)}</Text>}
          </Text>
        </Box>
      ))}
      {footer}
    </Box>
  )
}

async function refreshLogs($: Parameters<typeof update>[0] & Parameters<typeof scan>[0] & Parameters<typeof readBigLogs>[0], force = false) {
  const bump = () => void update($, logsVer, v => v + 1).catch(() => undefined)
  await scan($, { force }).catch(() => undefined)
  bump()
  await readBigLogs($, bump).catch(() => undefined)
  bump()
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const costNow = (await $.session.usage().catch(() => undefined))?.cost?.usd
    await update($, stats, s => {
      const base = s.startedAt ? s : { ...empty(), startedAt: now }
      return base.costAtStart === undefined && costNow !== undefined ? { ...base, costAtStart: costNow } : base
    })
    await $.command.register({ name: 'dash', description: 'Show a detailed dashboard of this session' })
    await $.command.register({ name: 'dashboard', description: 'Session dashboard; "history" for past sessions, "project" / "all" to pick which, "scan" to re-read logs' })
    void ensureOpen($)
    void refreshStatus($)
    // Read the logs, then the large ones by streaming, after the session is up.
    void refreshLogs($)
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
      const words = arg.split(/\s+/).filter(Boolean)
      if (words.includes('all')) await update($, scopeAtom, () => 'all' as const)
      if (words.includes('project')) await update($, scopeAtom, () => 'project' as const)
      const sc = await currentScope($)
      if (words.some(w => ['history', 'all', 'project', 'scan'].includes(w))) {
        const logs = await scan($, { force: words.includes('scan') })
        if (bigPending(logs) && !readingBig()) $.clock.after(10, () => void refreshLogs($))
        await update($, viewAtom, () => 'history' as const)
        void $.ui.open({ id: PANE, title: TITLE })
        const note = bigPending(logs) ? `\n\n  ${bigPending(logs)} large logs are being read in the background: run /dashboard history again in a minute or two.` : ''
        return { text: historyReport(logs, id, now, true, sc).replace(/^\n/, '') + note }
      }
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      const s = await read($, stats)
      const usage = await $.session.usage()
      const logs = await scan($).catch(() => loadScan($))
      const usable = logs.sessions.filter(x => x.id !== id && !x.tooBig && (x.prompts > 0 || x.calls > 0))
      const norm = normOf(usable.filter(x => inScope(x, sc)), usable)
      const cur = currentOf(s, usage.cost?.usd)
      const notes = findings({ s, cur, norm, contextPercent: usage.context.percent })
      const report = textReport(s, usage.cost?.usd, usage.context, [], now, { notes, cur, norm }) + '\n' + historyReport(logs, id, now, false, sc)
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
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const { hasSvg, PieChart, Gauge } = chartKit(table)
    const view = await read($, viewAtom)
    await read($, logsVer) // subscribes: redraw when the logs are re-read
    const Tabs = () => (
      <Box flexDirection="row" marginBottom={1}>
        <Button key="tab-session" variant={view === 'session' ? 'primary' : 'secondary'} hotkey="s" label="Session"
          onPress={() => void update($, viewAtom, () => 'session' as const)} />
        <Text> </Text>
        <Button key="tab-history" variant={view === 'history' ? 'primary' : 'secondary'} hotkey="h" label="History"
          onPress={() => void update($, viewAtom, () => 'history' as const)} />
      </Box>
    )
    if (view === 'history') return <Box flexDirection="column"><Tabs />{await historyPane($, e)}</Box>
    const s = await read($, stats)
    const showDetails = await read($, detailsAtom)
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const logs = await loadScan($)
    const myId = await $.session.id().catch(() => undefined)
    const sc = await currentScope($)
    const usable = logs.sessions.filter(x => x.id !== myId && !x.tooBig && (x.prompts > 0 || x.calls > 0))
    const past = usable.filter(x => inScope(x, sc)).sort((a, b) => b.end - a.end)
    const norm = normOf(past, usable)
    const cur = currentOf(s, usage.cost?.usd)
    const ctxPct = usage.context.percent
    const notes = findings({ s, cur, norm, contextPercent: ctxPct })
    const cols = Math.max(30, (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 60)
    const barW = Math.max(6, Math.min(24, cols - 30))

    const mainTurns = s.turns.filter(t => !t.isSub)
    const sum0 = summarize(s, usage.cost?.usd)
    const tools = [...s.tools].sort((a, b) => b.count - a.count).slice(0, 10)
    const maxCount = Math.max(1, ...tools.map(t => t.count))
    const recent = s.recent.slice(-8).reverse()
    const spent = usage.cost && s.costAtStart !== undefined ? usage.cost.usd - s.costAtStart : undefined

    const H = (p: { t: string; hint?: string }) => (
      <Box marginTop={1}>
        <Text bold color="cyan">{p.t}</Text>
        {p.hint && <Text dimColor>  {p.hint}</Text>}
      </Box>
    )
    // One row of "this session per prompt" against the norm.
    const Row = (p: { k: string; label: string; value: string; c?: ReturnType<typeof compare>; norm?: string }) => (
      <Box key={p.k}>
        <Text>
          {p.label.padEnd(14)} <Text bold>{p.value.padStart(7)}</Text>
          {p.c && p.c.arrow ? (
            <Text color={levelColor(p.c.level)}> {p.c.arrow} {p.c.label}</Text>
          ) : null}
          {p.norm ? <Text dimColor>  (usual {p.norm})</Text> : null}
        </Text>
      </Box>
    )
    const rows: { k: string; label: string; value: string; c?: ReturnType<typeof compare>; norm?: string }[] = []
    if (cur) {
      if (cur.usd !== undefined)
        rows.push({ k: 'usd', label: 'API-eq. cost', value: `$${cur.usd.toFixed(2)}`, c: norm?.usd !== undefined ? compare(cur.usd, norm.usd) : undefined, norm: norm?.usd !== undefined ? `$${norm.usd.toFixed(2)}` : undefined })
      rows.push({ k: 'time', label: 'Model time', value: fmtMs(cur.activeMs), c: norm ? compare(cur.activeMs, norm.activeMs) : undefined, norm: norm ? fmtMs(norm.activeMs) : undefined })
      rows.push({ k: 'calls', label: 'Tool calls', value: cur.calls.toFixed(1), c: norm ? compare(cur.calls, norm.calls) : undefined, norm: norm ? norm.calls.toFixed(1) : undefined })
      rows.push({ k: 'out', label: 'Output tokens', value: fmtN(cur.out), c: norm ? compare(cur.out, norm.out) : undefined, norm: norm ? fmtN(norm.out) : undefined })
      if (cur.calls > 0)
        rows.push({ k: 'err', label: 'Errors', value: `${Math.round(cur.errRate * 100)}%`, c: norm && norm.errRate > 0 ? compare(Math.max(cur.errRate, 0.0001), norm.errRate) : undefined, norm: norm ? `${Math.round(norm.errRate * 100)}%` : undefined })
    }
    const facts = [
      s.prompts ? `${s.prompts} prompts` : '',
      sum0.toolCalls ? `${sum0.toolCalls} calls` : '',
      sum0.activeMs ? fmtMs(sum0.activeMs) + ' working' : '',
      spent !== undefined && spent > 0.005 ? `$${spent.toFixed(2)} API-eq. since open` : '',
      usage.cost ? `$${usage.cost.usd.toFixed(2)} API-eq. session total` : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        <Tabs />
        {hasSvg && ctxPct !== undefined ? (
          <Box flexDirection="row" alignItems="center">
            <Gauge k="ctx-gauge" percent={ctxPct} caption="context" />
            <Box flexDirection="column" marginLeft={2}>
              <Text>Context <Text bold>{ctxPct}%</Text> <Text dimColor>of {fmtN(usage.context.window)}{usage.context.tokens ? ` · ${fmtN(usage.context.tokens)} used` : ''}</Text></Text>
              {facts.map(f => <Box key={`f-${f}`}><Text dimColor>{f}</Text></Box>)}
              {!facts.length && <Text dimColor>started {s.startedAt ? ago(now, s.startedAt) : '?'} ago, nothing yet</Text>}
            </Box>
          </Box>
        ) : (
          <Text dimColor>{facts.length ? facts.join(' · ') : `started ${s.startedAt ? ago(now, s.startedAt) : '?'} ago, nothing yet`}</Text>
        )}
        {!hasSvg && ctxPct !== undefined && (
          <Text>
            Context <Text color={ctxPct >= 80 ? 'red' : ctxPct >= 60 ? 'yellow' : 'green'}>{bar(ctxPct, 100, barW)}</Text> {ctxPct}%
            <Text dimColor> of {fmtN(usage.context.window)}</Text>
          </Text>
        )}

        {notes.length > 0 && <H t="What stands out" />}
        {notes.map((n: Insight, i: number) => (
          <Box key={`n-${i}`} flexDirection="column">
            <Text><Text color={levelColor(n.level)}>{levelIcon(n.level)}</Text> {n.text}</Text>
            {n.tip && <Text dimColor>   {n.tip}</Text>}
          </Box>
        ))}

        {rows.length > 0 && (
          <H t="Per prompt" hint={norm ? `vs your norm: ${norm.sessions} sessions${norm.isAllProjects ? ', all projects' : ''}` : 'norm appears after a few past sessions'} />
        )}
        {rows.map(r => <Row {...r} />)}
        {!cur && <Text dimColor>Per-prompt figures appear after your first prompt.</Text>}

        <Box flexDirection="row" marginTop={1}>
          <Button key="details" hotkey="d" label={showDetails ? 'Hide details' : 'Details'}
            onPress={() => void update($, detailsAtom, v => !v)} />
        </Box>

        {showDetails && (
          <Box flexDirection="column">
            {mainTurns.length > 1 && <H t="Turn duration" hint={`last ${Math.min(mainTurns.length, cols - 2)}`} />}
            {mainTurns.length > 1 && <Text color="magenta">{spark(mainTurns.slice(-(cols - 2)).map(t => t.ms))}</Text>}
            {mainTurns.length > 1 && <H t="Output tokens per turn" />}
            {mainTurns.length > 1 && <Text color="blue">{spark(mainTurns.slice(-(cols - 2)).map(t => t.out))}</Text>}

            {s.turns.length > 0 && hasSvg && (() => {
              const inp = s.turns.reduce((a, t) => a + t.inp, 0), cr = s.turns.reduce((a, t) => a + t.cacheRead, 0)
              const cw = s.turns.reduce((a, t) => a + t.cacheWrite, 0), o = s.turns.reduce((a, t) => a + t.out, 0)
              return (
                <Box flexDirection="column">
                  <H t="Where tokens go" />
                  <PieChart k="s-pie-tokens" title="Tokens this session" center={fmtN(inp + cr + cw + o)} caption="tokens"
                    slices={[
                      { label: 'cache read', value: cr, color: '#10B981', note: fmtN(cr) },
                      { label: 'cache write', value: cw, color: '#F59E0B', note: fmtN(cw) },
                      { label: 'uncached input', value: inp, color: '#EF4444', note: fmtN(inp) },
                      { label: 'output', value: o, color: '#4C8BF5', note: fmtN(o) },
                    ]} />
                </Box>
              )
            })()}
            {tools.length > 0 && <H t="Tools" hint={hasSvg ? 'share of calls · count · avg time · errors' : 'calls · avg time · errors'} />}
            {tools.length > 0 && hasSvg && (
              <PieChart k="s-pie-tools" title="Tool calls this session" center={`${sum0.toolCalls}`} caption="calls"
                slices={s.tools.map(t => ({ label: t.name, value: t.count, note: `${t.count} · ${fmtMs(t.ms / Math.max(1, t.count))}${t.errors ? ` · ✗${t.errors}` : ''}` }))} />
            )}
            {!hasSvg && tools.map(t => (
              <Box key={`tool-${t.name}`}>
                <Text>
                  {t.name.slice(0, 14).padEnd(14)} <Text color="cyan">{bar(t.count, maxCount, barW)}</Text> {String(t.count).padStart(3)}
                  <Text dimColor> {fmtMs(t.ms / Math.max(1, t.count))}</Text>
                  {t.errors > 0 && <Text color="red"> ✗{t.errors}</Text>}
                </Text>
              </Box>
            ))}

            {recent.length > 0 && <H t="Recent calls" />}
            {recent.map(r => (
              <Box key={`rc-${r.id}`}>
                <Text dimColor={r.status === 'ok'}>
                  <Text color={r.status === 'err' ? 'red' : r.status === 'deny' ? 'yellow' : r.status === 'run' ? 'cyan' : undefined}>
                    {r.status === 'ok' ? '✓' : r.status === 'err' ? '✗' : r.status === 'deny' ? '⊘' : '…'}
                  </Text>{' '}
                  {r.tool.slice(0, 28)} <Text dimColor>{r.status === 'run' ? 'running' : fmtMs(r.ms)} · {ago(now, r.at)} ago</Text>
                </Text>
              </Box>
            ))}

            {past.length > 0 && <H t={sc.scope === 'project' && sc.root ? `Past sessions · ${rootName(sc.root)}` : 'Past sessions'} />}
            {past.slice(0, 5).map(x => (
              <Box key={`ps-${x.id}`}>
                <Text>
                  <Text dimColor>{day(x.start)}</Text> {x.prompts}p · {x.calls} calls
                  {x.errors > 0 && <Text color="red"> · {x.errors} err</Text>} · {fmtMs(x.activeMs)}
                  {x.usd !== undefined && <Text dimColor> · ${x.usd.toFixed(2)}</Text>}
                </Text>
              </Box>
            ))}

            <Box flexDirection="row" marginTop={1}>
              <Button key="reset" label="Reset this session's stats"
                onPress={() => {
                  void (async () => {
                    const t = await $.clock.now()
                    const c = (await $.session.usage()).cost?.usd
                    await update($, stats, () => ({ ...empty(), startedAt: t, costAtStart: c }))
                  })()
                }} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
