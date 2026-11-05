// What a session did on each calendar day. One session can run over many days.
import type { HistSession } from '../types'

const two = (n: number) => String(n).padStart(2, '0')
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export type DayStat = { ms: number; usd?: number }

/** A summary kept from before days were counted has only the day it started. */
export const daysOf = (x: HistSession): Record<string, DayStat> =>
  x.days ?? { [dayKey(x.start)]: { ms: x.activeMs, usd: x.usd } }

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
