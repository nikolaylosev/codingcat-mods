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
