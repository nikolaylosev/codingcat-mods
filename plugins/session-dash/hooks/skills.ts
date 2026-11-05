// Skills across sessions. Logs say how many characters a skill put in the context,
// and the API bills whole requests, so the tokens and the cost here are estimates.
import type { HistSession } from '../types'

const CHARS_PER_TOKEN = 4
const CACHE_WRITE = 1.25
const CACHE_READ = 0.1

/** What one character costs, in characters of full-price input, when `later` requests read it again. */
export const loadCost = (later: number) => CACHE_WRITE + CACHE_READ * Math.max(0, later)

const tokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN)

export type SkillRow = { name: string; uses: number; sessions: number; tokens: number; cost: number }
export type SkillList = { sessions: number; tokens: number; cost: number }

/** The skills the sessions used, the costliest first. */
export function skillRows(xs: HistSession[]): SkillRow[] {
  const rows = new Map<string, { uses: number; sessions: number; chars: number; charCost: number }>()
  for (const x of xs)
    for (const [name, s] of Object.entries(x.skills ?? {})) {
      const r = rows.get(name) ?? { uses: 0, sessions: 0, chars: 0, charCost: 0 }
      rows.set(name, { uses: r.uses + s.uses, sessions: r.sessions + 1, chars: Math.max(r.chars, s.chars), charCost: r.charCost + s.charCost })
    }
  return [...rows]
    .map(([name, r]) => ({ name, uses: r.uses, sessions: r.sessions, tokens: tokens(r.chars), cost: tokens(r.charCost) }))
    .sort((a, b) => b.cost - a.cost || b.uses - a.uses)
}

/** The list of skills that a session's context holds whether or not it uses one. */
export function skillList(xs: HistSession[]): SkillList | undefined {
  const listed = xs.filter(x => x.listChars)
  if (!listed.length) return undefined
  return {
    sessions: listed.length,
    tokens: tokens(Math.max(...listed.map(x => x.listChars ?? 0))),
    cost: tokens(listed.reduce((t, x) => t + (x.listCost ?? 0), 0)),
  }
}

export const SKILLS_NOTE = 'Tokens are characters / 4. Cost is in full-price input tokens: a cache write counts 1.25, and each later read of the text counts 0.1.'
