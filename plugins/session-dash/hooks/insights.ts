// Turns raw numbers into what is worth noticing: per-prompt figures of this
// session against the person's own norm, and short findings with a tip each.
import type { HistSession, Stats } from '../types'

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
  max?: number
}): Insight[] {
  const { s, cur, norm, contextPercent } = args
  const out: Insight[] = []
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

  const denied = sum(s.tools, t => t.denied)
  if (denied >= 2) out.push({ level: 'warn', text: `${denied} tool calls denied`, tip: 'If they were fine, allow them in settings to avoid the back-and-forth' })

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
    usdPerDay.push(sum(all.filter(x => dayKey(x.start) === k), x => x.usd ?? 0))
  }
  const last30 = all.filter(x => x.end >= now - 30 * DAY)
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
    activeDays: new Set(last30.map(x => dayKey(x.start))).size,
    usd30: sum(last30, x => x.usd ?? 0),
    costly,
  }
}
