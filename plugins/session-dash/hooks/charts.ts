// Donut and pie charts as SVG source, for surfaces that draw `Svg`
// (desktop, VS Code, mobile). The terminal keeps the text bars.

export type Slice = { label: string; value: number; color?: string }

// Mid-tone colours that read on light and dark backgrounds alike.
// Red is kept out: it means trouble (errors, a full context) elsewhere.
export const PALETTE = ['#4C8BF5', '#F59E0B', '#10B981', '#8B5CF6', '#EC4899', '#14B8A6', '#A3A3A3']
const TRACK = '#8888882e'
const LABEL = '#8a8a8a'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/**
 * Keeps the `max - 1` biggest slices and folds the rest into "other",
 * giving each a colour from the palette.
 */
export function topSlices(slices: Slice[], max = 6): Slice[] {
  const sorted = slices.filter(s => s.value > 0).sort((a, b) => b.value - a.value)
  const kept = sorted.length > max ? sorted.slice(0, max - 1) : sorted
  const rest = sorted.length > max ? sorted.slice(max - 1).reduce((a, s) => a + s.value, 0) : 0
  const out = kept.map((s, i) => ({ ...s, color: s.color ?? PALETTE[i % (PALETTE.length - 1)] }))
  if (rest > 0) out.push({ label: 'other', value: rest, color: PALETTE[PALETTE.length - 1] })
  return out
}

/**
 * A donut: one ring segment per slice, drawn with stroke dashes on circles,
 * an optional big figure and caption in the hole.
 */
export function donutSvg(slices: Slice[], opts: { size?: number; thickness?: number; center?: string; caption?: string; total?: number } = {}): string {
  const size = opts.size ?? 120
  const w = opts.thickness ?? Math.round(size * 0.16)
  const r = (size - w) / 2
  const c = size / 2
  const C = 2 * Math.PI * r
  const total = opts.total ?? slices.reduce((a, s) => a + s.value, 0)
  let offset = 0
  const rings: string[] = [`<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="${w}"/>`]
  if (total > 0)
    for (const s of slices) {
      const len = (s.value / total) * C
      if (len <= 0) continue
      // A hairline gap between slices, none for a single full ring.
      const gap = slices.length > 1 && len > 2 ? 1 : 0
      rings.push(
        `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color ?? PALETTE[0]}" stroke-width="${w}" ` +
          `stroke-dasharray="${(len - gap).toFixed(2)} ${(C - len + gap).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" ` +
          `transform="rotate(-90 ${c} ${c})"/>`,
      )
      offset += len
    }
  const font = 'font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif"'
  const center = opts.center
    ? `<text x="${c}" y="${opts.caption ? c + 2 : c + size * 0.07}" text-anchor="middle" ${font} font-size="${Math.round(size * 0.2)}" font-weight="600" fill="${LABEL}">${esc(opts.center)}</text>`
    : ''
  const caption = opts.caption
    ? `<text x="${c}" y="${c + size * 0.17}" text-anchor="middle" ${font} font-size="${Math.round(size * 0.1)}" fill="${LABEL}">${esc(opts.caption)}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rings.join('')}${center}${caption}</svg>`
}

/** A one-value gauge: `percent` of the ring in a colour by threshold. */
export function gaugeSvg(percent: number, opts: { size?: number; caption?: string; warn?: number; bad?: number } = {}): string {
  const p = Math.max(0, Math.min(100, percent))
  const color = p >= (opts.bad ?? 80) ? '#EF4444' : p >= (opts.warn ?? 60) ? '#F59E0B' : '#10B981'
  return donutSvg([{ label: 'used', value: p, color }], { size: opts.size, total: 100, center: `${Math.round(p)}%`, caption: opts.caption })
}

export const altOf = (title: string, slices: Slice[]) => {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1
  return `${title}: ${slices.map(s => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}`
}

// One green at rising opacity, from the empty cell up: more is stronger on a
// light background and on a dark one alike (distinct greens flip on dark).
export const HEAT = ['#8888882e', '#2ea04359', '#2ea04399', '#2ea043cc', '#2ea043']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type HeatDay = { date: Date; value: number; level: number }

/**
 * A year of days ending today, in week columns (Monday first), each with a
 * level 0..4: 0 empty, then the quartiles of the days that had any activity.
 */
export function heatDays(valueOf: (d: Date) => number, today: Date, weeks = 53): HeatDay[][] {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const dow = (end.getDay() + 6) % 7 // Monday 0
  const start = new Date(end)
  start.setDate(end.getDate() - dow - (weeks - 1) * 7)
  const cols: HeatDay[][] = []
  const all: number[] = []
  for (let w = 0; w < weeks; w++) {
    const col: HeatDay[] = []
    for (let d = 0; d < 7; d++) {
      const date = new Date(start)
      date.setDate(start.getDate() + w * 7 + d)
      if (date > end) break
      const value = valueOf(date)
      if (value > 0) all.push(value)
      col.push({ date, value, level: 0 })
    }
    cols.push(col)
  }
  all.sort((a, b) => a - b)
  const q = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)]
  for (const col of cols)
    for (const day of col) day.level = day.value <= 0 ? 0 : day.value <= cuts[0]! ? 1 : day.value <= cuts[1]! ? 2 : day.value <= cuts[2]! ? 3 : 4
  return cols
}

const MAX_LABELED_BARS = 12

export type BarsOptions = {
  /** The number over a bar, as long as the bars are few enough to have one each. */
  label?: (value: number) => string
  /** Text under the bars, at a bar's position. */
  ticks?: { at: number; text: string }[]
}

/**
 * Bars for a run of values, one bar per value. With no width of its own on the element,
 * the drawing shrinks with the pane, so it never wraps as a row of text characters can.
 */
export function barsSvg(values: number[], color: string, opts: BarsOptions = {}): string {
  const w = 640
  const barsHigh = 56
  const font = 'font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="18" fill="#9a9a9a"'
  // A number over each bar fits only while the bars are few.
  const label = values.length <= MAX_LABELED_BARS ? opts.label : undefined
  const top = label ? 24 : 0
  const ticks = opts.ticks ?? []
  const h = top + barsHigh + (ticks.length ? 24 : 0)
  const max = Math.max(...values, 0)
  const step = Math.min(w / Math.max(1, values.length), 96)
  const bar = Math.max(1, step * 0.72)
  const center = (i: number) => i * step + step / 2
  const parts = values.map((v, i) => {
    // A value of nothing keeps a thin mark, so the run still reads as days or hours.
    const height = v > 0 && max > 0 ? Math.max(4, (v / max) * barsHigh) : 2
    const fill = v > 0 ? color : '#8a8a8a'
    const y = top + barsHigh - height
    const rect = `<rect x="${(center(i) - bar / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bar.toFixed(1)}" height="${height.toFixed(1)}" rx="1.5" fill="${fill}"${v > 0 ? '' : ' opacity="0.35"'}/>`
    return label ? `${rect}<text x="${center(i).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" ${font}>${label(v)}</text>` : rect
  })
  for (const t of ticks) {
    const anchor = t.at === 0 ? 'start' : t.at === values.length - 1 ? 'end' : 'middle'
    const x = t.at === 0 ? 0 : t.at === values.length - 1 ? values.length * step : center(t.at)
    parts.push(`<text x="${x.toFixed(1)}" y="${h - 4}" text-anchor="${anchor}" ${font}>${t.text}</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`
}

export function heatmapSvg(cols: HeatDay[][], opts: { cell?: number } = {}): string {
  const c = opts.cell ?? 10
  const gap = 2
  const left = 22
  const top = 14
  const w = left + cols.length * (c + gap)
  const h = top + 7 * (c + gap)
  const font = 'font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="9" fill="#8a8a8a"'
  const parts: string[] = []
  let lastMonth = -1
  cols.forEach((col, x) => {
    const first = col[0]
    if (first && first.date.getMonth() !== lastMonth && first.date.getDate() <= 7) {
      lastMonth = first.date.getMonth()
      parts.push(`<text x="${left + x * (c + gap)}" y="10" ${font}>${MONTHS[lastMonth]}</text>`)
    }
    col.forEach((day, y) =>
      parts.push(`<rect x="${left + x * (c + gap)}" y="${top + y * (c + gap)}" width="${c}" height="${c}" rx="2" fill="${HEAT[day.level]}"/>`),
    )
  })
  for (const [i, label] of [[0, 'Mon'], [2, 'Wed'], [4, 'Fri']] as const)
    parts.push(`<text x="0" y="${top + i * (c + gap) + c - 1}" ${font}>${label}</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`
}

/** The same year as seven text rows, for the terminal. */
export function heatmapText(cols: HeatDay[][]): string[] {
  const glyph = [' ', '░', '▒', '▓', '█']
  return Array.from({ length: 7 }, (_, d) => cols.map(col => (col[d] ? glyph[col[d]!.level] : ' ')).join(''))
}

export function streaks(cols: HeatDay[][]): { current: number; longest: number; activeDays: number } {
  const days = cols.flat()
  let longest = 0
  let run = 0
  for (const d of days) {
    run = d.value > 0 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  let current = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]!.value > 0) current++
    else if (i === days.length - 1) continue // today not started yet still counts the run before it
    else break
  }
  return { current, longest, activeDays: days.filter(d => d.value > 0).length }
}
