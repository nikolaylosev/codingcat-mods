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
