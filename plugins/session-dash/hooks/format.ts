// Plain text helpers: numbers, durations, bars, dates and padding.
import { dur } from './insights'
import { paceTooEarly } from './limits'
import type { LimitView } from './limits'

export const fmtN = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`
export const fmtMs = (ms: number) =>
  ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
export const bar = (v: number, max: number, w: number) => {
  const n = max > 0 ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * w)) : 0
  return '█'.repeat(n) + '·'.repeat(Math.max(0, w - n))
}
const SPARK = '▁▂▃▄▅▆▇█'
export const spark = (vals: number[]) => {
  const max = Math.max(1, ...vals)
  return vals.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}
/** "1 commit", "2 commits". */
export const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
export const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}
export const pad = (v: string | number, n: number) => String(v).padStart(n)
export const padR = (v: string, n: number) => (v.length > n ? v.slice(0, n - 1) + '…' : v.padEnd(n))
const two = (n: number) => String(n).padStart(2, '0')
// Local time of the machine the session runs on.
export const clock = (t: number) => {
  const d = new Date(t)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
export const day = (t: number) => {
  const d = new Date(t)
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(t)}`
}
export { dayKey } from './days'
export const DAY = 24 * 3600 * 1000

/**
 * A window's pace: what it uses per hour, then when it is full at that pace.
 * A full that comes after the reset says the window lasts; one that comes
 * before it while the week is young says it is early to tell.
 */
export const paceParts = (l: LimitView): { rate?: string; full: string } => {
  if (l.pct >= 100) return { full: 'used up' }
  if (l.ratePerHour === undefined) return { full: 'pace: measuring…' }
  if (l.ratePerHour <= 0.05 || l.fullInMs === undefined) return { full: 'idle' }
  const rate = `${l.ratePerHour.toFixed(1)}%/h`
  const full = `full in ${dur(l.fullInMs)} at this pace`
  if (l.runsOut || l.resetsInMs === undefined) return { rate, full }
  if (l.fullInMs >= l.resetsInMs) return { rate, full: `${full}: lasts past reset` }
  return { rate, full: paceTooEarly(l.kind, l.pct) ? `${full} (early to tell)` : full }
}

export const paceText = (l: LimitView) => {
  const p = paceParts(l)
  return p.rate ? `${p.rate} · ${p.full}` : p.full
}
