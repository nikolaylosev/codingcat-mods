// The plugin's own values and what is worked out from them: scope, totals, search.
import type { HistSession, PastSession, Stats } from '../types'
import { sinceDay } from './days'
import { day, dayKey, pct } from './format'
import { projectName } from './history'
import type { EngineInterface } from 'claude-code'


export const PANE = 'session-dash'
export const TITLE = 'Session dashboard'
export const empty = (): Stats => ({ startedAt: 0, turns: [], tools: [], recent: [], prompts: 0 })

/** Every word of the query must appear in the session's project, branch, first prompt or date. */
export function searchSessions(xs: HistSession[], query: string): HistSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return xs
    .filter(x => {
      const hay = `${x.project} ${projectName(x)} ${x.branch ?? ''} ${Object.keys(x.branches ?? {}).join(' ')} ${x.firstPrompt ?? ''} ${day(x.start)} ${dayKey(x.start)}`.toLowerCase()
      return words.every(w => hay.includes(w))
    })
    .sort((a, b) => b.end - a.end)
}

export type Scope = { scope: 'project' | 'all'; root: string }
const trimSlash = (p: string) => p.replace(/[\\/]+$/, '')
/** A session belongs to the project when it ran in its root or below it. */
export const inScope = (x: HistSession, sc: Scope) => {
  if (sc.scope === 'all' || !sc.root) return true
  const root = trimSlash(sc.root)
  if (x.project) {
    const p = trimSlash(x.project)
    return p === root || p.startsWith(root + '/') || p.startsWith(root + '\\')
  }
  return x.folder === root.replace(/[^a-zA-Z0-9]/g, '-')
}
export const rootName = (root: string) => trimSlash(root).split(/[\\/]/).pop() || root

export function summarize(s: Stats, usd?: number): PastSession {
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

export type Agg = { n: number; prompts: number; calls: number; errors: number; out: number; activeMs: number; usd: number; hasUsd: boolean }
export const agg = (list: HistSession[]): Agg =>
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

/** A period's sessions; their time and cost only as far as they fall in the period. */
export function aggSince(list: HistSession[], since: number): Agg {
  const xs = list.filter(x => x.end >= since)
  const days = sinceDay(xs, since)
  return { ...agg(xs), activeMs: days.ms, usd: days.usd }
}

export const merge = (list: HistSession[], f: (x: HistSession) => Record<string, number>) => {
  const r: Record<string, number> = {}
  for (const x of list) for (const [k, v] of Object.entries(f(x))) r[k] = (r[k] ?? 0) + v
  return Object.entries(r).sort((a, b) => b[1] - a[1])
}

export type Usage = Awaited<ReturnType<EngineInterface['session']['usage']>>
