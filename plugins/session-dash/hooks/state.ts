// The plugin's own values and what is worked out from them: scope, totals, search.
import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { HistSession, PastSession, Stats } from '../types'
import { day, dayKey, pct } from './format'
import { projectName } from './history'

// The engine's scan reads an atom only from a const of the file that uses it.
// Which sessions the history counts: those of the session's project, or all.
const scopeAtom = atom({ plugin: 'session-dash', key: 'scope' } as const, 'project' as 'project' | 'all')

export const PANE = 'session-dash'
export const TITLE = 'Session dashboard'
export const empty = (): Stats => ({ startedAt: 0, turns: [], tools: [], recent: [], prompts: 0 })

/** Every word of the query must appear in the session's project, branch, first prompt or date. */
export function searchSessions(xs: HistSession[], query: string): HistSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return xs
    .filter(x => {
      const hay = `${x.project} ${projectName(x)} ${x.branch ?? ''} ${x.firstPrompt ?? ''} ${day(x.start)} ${dayKey(x.start)}`.toLowerCase()
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
/** No known root (a host without one): every project. */
export async function currentScope($: EngineInterface): Promise<Scope> {
  const root = await $.session.root().catch(() => '')
  return { scope: root ? await read($, scopeAtom) : 'all', root }
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
export const merge = (list: HistSession[], f: (x: HistSession) => Record<string, number>) => {
  const r: Record<string, number> = {}
  for (const x of list) for (const [k, v] of Object.entries(f(x))) r[k] = (r[k] ?? 0) + v
  return Object.entries(r).sort((a, b) => b[1] - a[1])
}

type Ui = { ui: { open: (a: { id: string; title: string }) => Promise<{ isPlaced: boolean }> } }

export async function ensureOpen($: Ui) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  return r.isPlaced
}
