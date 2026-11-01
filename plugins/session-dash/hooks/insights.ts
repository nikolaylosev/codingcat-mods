// Turns raw numbers into what is worth noticing: per-prompt figures of this
// session against the person's own norm, and short findings with a tip each.
import type { HistSession, Stats } from '../types'
import type { LimitView } from './limits'
import { daysOf, sinceDay } from './days'
import { ERROR_TIPS } from './signals'
import type { ErrorKind } from './signals'

export type PerPrompt = {
  prompts: number
  usd?: number // dollars per prompt
  calls: number // tool calls per prompt
  out: number // output tokens per prompt
  activeMs: number // model working time per prompt
  errRate: number // tool errors / tool calls, 0..1
  cacheHit: number // 0..100
}

export type Norm = PerPrompt & { sessions: number; isAllProjects: boolean }

export type Level = 'bad' | 'warn' | 'good' | 'info'
export type Insight = { level: Level; text: string; tip?: string }

export type Compare = { ratio: number; arrow: string; level: Level; label: string }

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)

/** The norm: totals over past sessions divided by their prompts. */
export function normOf(project: HistSession[], all: HistSession[]): Norm | undefined {
  const usable = (xs: HistSession[]) => xs.filter(x => x.prompts > 0)
  let pool = usable(project)
  let isAllProjects = false
  if (pool.length < 3) {
    pool = usable(all)
    isAllProjects = true
  }
  if (pool.length < 2) return undefined
  const prompts = sum(pool, x => x.prompts)
  const priced = pool.filter(x => x.usd !== undefined)
  const pricedPrompts = sum(priced, x => x.prompts)
  const calls = sum(pool, x => x.calls)
  const inTot = sum(pool, x => x.inp + x.cr + x.cw)
  return {
    sessions: pool.length,
    isAllProjects,
    prompts,
    usd: pricedPrompts ? sum(priced, x => x.usd ?? 0) / pricedPrompts : undefined,
    calls: calls / prompts,
    out: sum(pool, x => x.out) / prompts,
    activeMs: sum(pool, x => x.activeMs) / prompts,
    errRate: calls ? sum(pool, x => x.errors) / calls : 0,
    cacheHit: inTot ? (sum(pool, x => x.cr) / inTot) * 100 : 0,
  }
}

/** This session per prompt, from the live counters since the mod loaded. */
export function currentOf(s: Stats, costNow: number | undefined): PerPrompt | undefined {
  const main = s.turns.filter(t => !t.isSub)
  const prompts = s.prompts || main.filter(t => t.prompt).length
  if (!prompts) return undefined
  const calls = sum(s.tools, t => t.count)
  const errors = sum(s.tools, t => t.errors)
  const inTot = sum(s.turns, t => t.inp + t.cacheRead + t.cacheWrite)
  const spent = costNow !== undefined && s.costAtStart !== undefined ? costNow - s.costAtStart : undefined
  return {
    prompts,
    usd: spent !== undefined ? spent / prompts : undefined,
    calls: calls / prompts,
    out: sum(s.turns, t => t.out) / prompts,
    activeMs: sum(main, t => t.ms) / prompts,
    errRate: calls ? errors / calls : 0,
    cacheHit: inTot ? (sum(s.turns, t => t.cacheRead) / inTot) * 100 : 0,
  }
}

/** A span for people: 45m, 2h 10m, 3d 4h. */
export function dur(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`
  const h = Math.round(m / 60)
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * Prompts until the context reaches `limit`, at its rise over the last few;
 * undefined while it is far off or the rise is unclear.
 */
export function promptsLeft(trail: number[] | undefined, limit = 100): number | undefined {
  const xs = trail ?? []
  // A drop is a compaction: only what came after it counts.
  const start = xs.reduce((from, x, i) => (i && x < (xs[i - 1] ?? 0) ? i : from), 0)
  const run = xs.slice(start).slice(-6)
  const first = run[0] ?? 0
  const last = run[run.length - 1] ?? 0
  if (run.length < 3 || last < 50 || last <= first) return undefined
  const left = Math.max(0, Math.floor((limit - last) / ((last - first) / (run.length - 1))))
  return left <= 20 ? left : undefined
}

/**
 * How a value stands against the norm. `higherIsWorse` decides the colour;
 * within ±25% it is "as usual".
 */
export function compare(value: number, norm: number, higherIsWorse = true): Compare {
  if (!(norm > 0)) return { ratio: 1, arrow: '', level: 'info', label: '' }
  const ratio = value / norm
  if (ratio >= 0.8 && ratio <= 1.25) return { ratio, arrow: '≈', level: 'good', label: 'as usual' }
  const up = ratio > 1
  const worse = up === higherIsWorse
  const label = up ? `${ratio.toFixed(1)}× norm` : `${Math.round((1 - ratio) * 100)}% below`
  return { ratio, arrow: up ? '↑' : '↓', level: worse ? (ratio >= 2 || ratio <= 0.5 ? 'bad' : 'warn') : 'good', label }
}

/** Findings worth a look, the most pressing first, at most `max`. */
export function findings(args: {
  s: Stats
  cur?: PerPrompt
  norm?: Norm
  contextPercent?: number
  limits?: LimitView[]
  max?: number
}): Insight[] {
  const { s, cur, norm, contextPercent } = args
  const out: Insight[] = []

  for (const l of args.limits ?? []) {
    if (l.pct >= 100) out.push({ level: 'bad', text: `${l.label} limit used up`, tip: l.resetsInMs !== undefined ? `Resets in ${dur(l.resetsInMs)}` : undefined })
    else if (l.runsOut && l.fullInMs !== undefined)
      out.push({
        level: 'bad',
        text: `${l.label} limit ${Math.round(l.pct)}%: at this pace full in ${dur(l.fullInMs)}`,
        tip: `It resets in ${l.resetsInMs !== undefined ? dur(l.resetsInMs) : '?'}: slow down, /compact, or move light work to a smaller model`,
      })
    else if (l.pct >= 80) out.push({ level: 'warn', text: `${l.label} limit at ${Math.round(l.pct)}%`, tip: l.resetsInMs !== undefined ? `Resets in ${dur(l.resetsInMs)}` : undefined })
  }

  const kinds = Object.entries(s.errKinds ?? {}) as [ErrorKind, number][]
  const rejected = kinds.find(([k]) => k === 'rejected')?.[1] ?? 0
  const denied = kinds.find(([k]) => k === 'denied')?.[1] ?? 0
  if (rejected >= 2) out.push({ level: 'warn', text: `You rejected ${rejected} tool calls`, tip: ERROR_TIPS.rejected })
  if (denied >= 2) out.push({ level: 'warn', text: `${denied} tool calls denied`, tip: ERROR_TIPS.denied })
  const topKind = kinds.filter(([k]) => !['rejected', 'denied', 'other', 'no output', 'non-zero exit'].includes(k)).sort((a, b) => b[1] - a[1])[0]
  if (topKind && topKind[1] >= 3) out.push({ level: 'warn', text: `${topKind[1]} errors: ${topKind[0]}`, tip: ERROR_TIPS[topKind[0]] })
  const main = s.turns.filter(t => !t.isSub)

  if (contextPercent !== undefined && contextPercent >= 80)
    out.push({ level: 'bad', text: `Context ${contextPercent}% full`, tip: 'Run /compact or start a fresh session before quality drops' })
  else if (contextPercent !== undefined && contextPercent >= 60)
    out.push({ level: 'warn', text: `Context ${contextPercent}% full`, tip: 'Plan a /compact at the next natural break' })

  for (const t of [...s.tools].sort((a, b) => b.errors - a.errors)) {
    if (t.count >= 3 && t.errors / t.count >= 0.25)
      out.push({
        level: t.errors / t.count >= 0.5 ? 'bad' : 'warn',
        text: `${t.name} failed ${t.errors} of ${t.count} calls`,
        tip: t.name === 'Bash' ? 'Check the commands, paths or missing tools it keeps hitting' : 'Look at what it was given: wrong paths or arguments repeat',
      })
  }


  const interrupted = main.filter(t => t.reason === 'aborted').length
  if (interrupted >= 2) out.push({ level: 'warn', text: `${interrupted} turns interrupted`, tip: 'Often a sign the request was unclear or the model went the wrong way' })
  const failed = main.filter(t => t.reason === 'error' || t.reason === 'refusal').length
  if (failed) out.push({ level: 'bad', text: `${failed} turns ended with an error`, tip: 'API errors or limits: check the status line and retry' })

  if (cur && norm) {
    if (cur.usd !== undefined && norm.usd !== undefined) {
      const c = compare(cur.usd, norm.usd)
      if (c.level === 'bad' || c.level === 'warn')
        out.push({ level: c.level, text: `API-equivalent cost per prompt $${cur.usd.toFixed(2)}, ${c.label} ($${norm.usd.toFixed(2)})`, tip: 'Long context and big tool outputs drive it: /compact, narrower reads' })
    }
    const calls = compare(cur.calls, norm.calls)
    if (calls.level === 'bad' || calls.level === 'warn')
      out.push({ level: calls.level, text: `${cur.calls.toFixed(1)} tool calls per prompt, ${calls.label}`, tip: 'The model is searching a lot: name files and the goal more precisely' })
    const time = compare(cur.activeMs, norm.activeMs)
    if (time.level === 'bad')
      out.push({ level: 'warn', text: `Prompts take ${time.label} as long as usual`, tip: 'Split big asks into steps you can check' })
    if (cur.cacheHit && norm.cacheHit && cur.cacheHit < norm.cacheHit - 15)
      out.push({ level: 'warn', text: `Cache hit ${Math.round(cur.cacheHit)}% vs usual ${Math.round(norm.cacheHit)}%`, tip: 'Long pauses (over 5 min) or switching models reset the cache' })
  } else if (cur && cur.cacheHit && cur.cacheHit < 60 && sum(s.turns, t => t.inp + t.cacheRead + t.cacheWrite) > 50000) {
    out.push({ level: 'warn', text: `Cache hit only ${Math.round(cur.cacheHit)}%`, tip: 'Long pauses or model switches reset the cache' })
  }

  const order: Record<Level, number> = { bad: 0, warn: 1, info: 2, good: 3 }
  out.sort((a, b) => order[a.level] - order[b.level])
  if (!out.length && main.length >= 2) out.push({ level: 'good', text: 'Nothing stands out: this session runs as usual' })
  return out.slice(0, args.max ?? 5)
}

export const levelColor = (l: Level) => (l === 'bad' ? 'red' : l === 'warn' ? 'yellow' : l === 'good' ? 'green' : undefined)
export const levelIcon = (l: Level) => (l === 'bad' ? '●' : l === 'warn' ? '▲' : l === 'good' ? '✓' : '·')

const DAY = 24 * 3600 * 1000

export type Efficiency = {
  hasCost: boolean
  week: PerPrompt | undefined // the last 7 days
  before: PerPrompt | undefined // the 23 days before them
  usdPerDay: number[] // 30 values, oldest first
  activeDays: number
  usd30: number
  costly: { s: HistSession; usdPerPrompt?: number }[]
}

const perPrompt = (xs: HistSession[]): PerPrompt | undefined => {
  const prompts = sum(xs, x => x.prompts)
  if (!prompts) return undefined
  const priced = xs.filter(x => x.usd !== undefined)
  const pp = sum(priced, x => x.prompts)
  const calls = sum(xs, x => x.calls)
  const inTot = sum(xs, x => x.inp + x.cr + x.cw)
  return {
    prompts,
    usd: pp ? sum(priced, x => x.usd ?? 0) / pp : undefined,
    calls: calls / prompts,
    out: sum(xs, x => x.out) / prompts,
    activeMs: sum(xs, x => x.activeMs) / prompts,
    errRate: calls ? sum(xs, x => x.errors) / calls : 0,
    cacheHit: inTot ? (sum(xs, x => x.cr) / inTot) * 100 : 0,
  }
}

export function efficiency(all: HistSession[], now: number, dayKey: (t: number) => string): Efficiency {
  const week = all.filter(x => x.end >= now - 7 * DAY)
  const before = all.filter(x => x.end < now - 7 * DAY && x.end >= now - 30 * DAY)
  const usdPerDay: number[] = []
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(now - i * DAY)
    usdPerDay.push(sum(all, x => daysOf(x)[k]?.usd ?? 0))
  }
  const last30 = all.filter(x => x.end >= now - 30 * DAY)
  const from = dayKey(now - 30 * DAY)
  const costly = [...all]
    .filter(x => x.usd !== undefined)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    .slice(0, 5)
    .map(s => ({ s, usdPerPrompt: s.prompts ? (s.usd ?? 0) / s.prompts : undefined }))
  return {
    hasCost: all.some(x => x.usd !== undefined),
    week: perPrompt(week),
    before: perPrompt(before),
    usdPerDay,
    activeDays: new Set(last30.flatMap(x => Object.keys(daysOf(x)).filter(k => k >= from))).size,
    usd30: sinceDay(last30, now - 30 * DAY).usd,
    costly,
  }
}

export type Output = {
  added: number
  removed: number
  commits: number
  prs: number
  tokens: number
  usd?: number
  /** Lines added per million tokens, the SigNoz efficiency ratio. */
  linesPerM?: number
  commitsPerM?: number
  linesPerUsd?: number
  isEstimated: boolean
}

/** What the sessions produced, and per million tokens or dollar. */
export function outputOf(xs: HistSession[]): Output {
  const tokens = sum(xs, x => x.inp + x.cr + x.cw + x.out)
  const added = sum(xs, x => x.linesAdded ?? 0)
  const commits = sum(xs, x => x.commits ?? 0)
  const priced = xs.filter(x => x.usd !== undefined)
  const usd = priced.length ? sum(priced, x => x.usd ?? 0) : undefined
  return {
    added,
    removed: sum(xs, x => x.linesRemoved ?? 0),
    commits,
    prs: sum(xs, x => x.prs ?? 0),
    tokens,
    usd,
    linesPerM: tokens ? (added / tokens) * 1e6 : undefined,
    commitsPerM: tokens ? (commits / tokens) * 1e6 : undefined,
    linesPerUsd: usd ? sum(priced, x => x.linesAdded ?? 0) / usd : undefined,
    isEstimated: xs.some(x => x.linesEstimated),
  }
}

export type Trouble = {
  prompts: number
  rejections: number
  interrupts: number
  compactions: number
  apiErrors: number
  retryMs: number
  errors: number
  calls: number
}

export function troubleOf(xs: HistSession[]): Trouble {
  return {
    prompts: sum(xs, x => x.prompts),
    rejections: sum(xs, x => x.rejections ?? 0),
    interrupts: sum(xs, x => x.interrupts ?? 0),
    compactions: sum(xs, x => x.compactions ?? 0),
    apiErrors: sum(xs, x => x.apiErrors ?? 0),
    retryMs: sum(xs, x => x.retryMs ?? 0),
    errors: sum(xs, x => x.errors),
    calls: sum(xs, x => x.calls),
  }
}

/** Per 10 prompts, the unit trouble signals compare in. */
export const per10 = (n: number, prompts: number) => (prompts ? (n / prompts) * 10 : 0)

export function errKindsOf(xs: HistSession[]): [string, number][] {
  const r: Record<string, number> = {}
  for (const x of xs) for (const [k, v] of Object.entries(x.errKinds ?? {})) r[k] = (r[k] ?? 0) + v
  return Object.entries(r).sort((a, b) => b[1] - a[1])
}

export function subShareOf(xs: HistSession[]): { main: number; sub: number; subCalls: number } {
  const total = sum(xs, x => x.inp + x.cr + x.cw + x.out)
  const sub = sum(xs, x => (x.subIn ?? 0) + (x.subOut ?? 0))
  return { main: Math.max(0, total - sub), sub, subCalls: sum(xs, x => x.subCalls ?? 0) }
}
