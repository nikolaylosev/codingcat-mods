// Subscription windows (five_hour, seven_day): how full each is, how fast it
// fills, and whether it runs out before it resets. Readings are kept in the
// plugin's store, so every session of the account adds to the same picture.
import type { LimitSample } from '../types'

export const SAMPLES_KEY = 'limit-samples-1'
export const KEEP_MS = 8 * 24 * 3600 * 1000
export const MIN_GAP_MS = 60 * 1000




/** A few hours say little about a week: its pace counts once it is half used. */
export const paceTooEarly = (kind: string, pct: number) => kind === 'seven_day' && pct < 50

export type LimitView = {
  kind: string
  label: string
  pct: number
  resetsInMs?: number
  /** Percent per hour over the recent readings of this window. */
  ratePerHour?: number
  /** When the window fills at that rate, from now. */
  fullInMs?: number
  /** True when it fills before it resets. */
  runsOut: boolean
}

const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'Spend limit' }

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

/**
 * Each window now, and its pace. five_hour: the rise over its readings of the
 * last hour, since one sitting fills it. seven_day: the rise over at least a
 * day, from the newest reading a day old, else from the window's start at 0%,
 * so that nights and days off count as they will until it resets.
 */
export function limitView(
  current: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  samples: LimitSample[],
  now: number,
): LimitView[] {
  return current.map(r => {
    const resetsAt = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    const resetsInMs = Number.isNaN(resetsAt) ? undefined : Math.max(0, resetsAt - now)
    const same = samples.filter(x => x.kind === r.kind && x.resetsAt === r.resetsAt)
    const weekStart = Number.isNaN(resetsAt) ? undefined : resetsAt - 7 * DAY
    const first = r.kind === 'seven_day'
      ? (same.filter(x => now - x.t >= DAY).at(-1) ?? (weekStart !== undefined && weekStart < now ? { t: weekStart, pct: 0 } : undefined))
      : same.find(x => now - x.t <= (r.kind === 'five_hour' ? HOUR : DAY))
    let ratePerHour: number | undefined
    if (first && now - first.t >= 5 * 60 * 1000 && r.percentUsed >= first.pct)
      ratePerHour = ((r.percentUsed - first.pct) / (now - first.t)) * 3600 * 1000
    const fullInMs = ratePerHour && ratePerHour > 0 ? ((100 - r.percentUsed) / ratePerHour) * 3600 * 1000 : undefined
    const runsOut = r.percentUsed >= 100 || (!paceTooEarly(r.kind, r.percentUsed) && fullInMs !== undefined && resetsInMs !== undefined && fullInMs < resetsInMs)
    return { kind: r.kind, label: LABELS[r.kind] ?? r.kind, pct: r.percentUsed, resetsInMs, ratePerHour, fullInMs, runsOut }
  })
}
