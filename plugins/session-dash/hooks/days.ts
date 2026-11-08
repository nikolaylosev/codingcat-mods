// What a session did on each calendar day. One session can run over many days.
import type { DayCounts, HistSession } from '../types'

const two = (n: number) => String(n).padStart(2, '0')
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export type DayStat = { ms: number; usd?: number }

/** A summary kept from before days were counted has only the day it started. */
export const daysOf = (x: HistSession): Record<string, DayStat> =>
  x.days ?? { [dayKey(x.start)]: { ms: x.activeMs, usd: x.usd } }

/** A summary kept from before counts per day, whose log is gone, has them all on its last day. */
export const countsOf = (x: HistSession): Record<string, DayCounts> =>
  x.counts ?? {
    [dayKey(x.end)]: {
      prompts: x.prompts, calls: x.calls, errors: x.errors, out: x.out, inp: x.inp, cr: x.cr, cw: x.cw,
      added: x.linesAdded, removed: x.linesRemoved, commits: x.commits, prs: x.prs, rejections: x.rejections,
      interrupts: x.interrupts, compactions: x.compactions, apiErrors: x.apiErrors, retryMs: x.retryMs,
    },
  }

/** The session as far as it falls on the days from `from` up to, and not including, `to`. */
export function within(x: HistSession, from: string, to?: string): HistSession {
  const inside = (k: string) => k >= from && (to === undefined || k < to)
  const c: DayCounts = {}
  for (const [k, d] of Object.entries(countsOf(x)))
    if (inside(k)) for (const [f, n] of Object.entries(d) as [keyof DayCounts, number | undefined][]) c[f] = (c[f] ?? 0) + (n ?? 0)
  let activeMs = 0
  let usd = 0
  for (const [k, d] of Object.entries(daysOf(x)))
    if (inside(k)) {
      activeMs += d.ms
      usd += d.usd ?? 0
    }
  return {
    ...x, activeMs, usd: x.usd === undefined ? undefined : usd,
    prompts: c.prompts ?? 0, calls: c.calls ?? 0, errors: c.errors ?? 0, out: c.out ?? 0, inp: c.inp ?? 0, cr: c.cr ?? 0, cw: c.cw ?? 0,
    linesAdded: c.added ?? 0, linesRemoved: c.removed ?? 0, commits: c.commits ?? 0, prs: c.prs ?? 0, rejections: c.rejections ?? 0,
    interrupts: c.interrupts ?? 0, compactions: c.compactions ?? 0, apiErrors: c.apiErrors ?? 0, retryMs: c.retryMs ?? 0,
  }
}

/** It did work, but its log holds no cost: it has not ended yet, or its Claude Code wrote none. */
export const unpriced = (x: HistSession) => x.usd === undefined && x.out > 0

/** Active time and cost of these sessions on the days from `since` on. */
export function sinceDay(xs: HistSession[], since: number) {
  const from = dayKey(since)
  let ms = 0
  let usd = 0
  for (const x of xs)
    for (const [k, d] of Object.entries(daysOf(x)))
      if (k >= from) {
        ms += d.ms
        usd += d.usd ?? 0
      }
  return { ms, usd }
}

/** Active time per day, for charts. */
export function msPerDay(xs: HistSession[]) {
  const r = new Map<string, number>()
  for (const x of xs) for (const [k, d] of Object.entries(daysOf(x))) r.set(k, (r.get(k) ?? 0) + d.ms)
  return r
}

/** Active time per hour of the day. A summary without hours has it all in the hour it started. */
export function msPerHour(xs: HistSession[]) {
  const r = Array.from({ length: 24 }, () => 0)
  for (const x of xs) {
    const hours = x.hours ?? r.map((_, h) => (h === new Date(x.start).getHours() ? x.activeMs : 0))
    hours.forEach((ms, h) => { r[h] = (r[h] ?? 0) + ms })
  }
  return r
}

/** Active time per weekday, Sunday first. */
export function msPerWeekday(xs: HistSession[]) {
  const r = Array.from({ length: 7 }, () => 0)
  for (const [key, ms] of msPerDay(xs)) {
    const [y = 0, m = 1, d = 1] = key.split('-').map(Number)
    const w = new Date(y, m - 1, d).getDay()
    r[w] = (r[w] ?? 0) + ms
  }
  return r
}
