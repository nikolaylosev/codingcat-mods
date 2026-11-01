// The charts panes draw, for the surface at hand.
import type { ElementConstructor, ElementTable, EngineInterface, SvgProps } from 'claude-code'
import { altOf, barsSvg, donutSvg, gaugeSvg, topSlices } from './charts'
import { spark } from './format'
import type { BarsOptions, Slice } from './charts'

export type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

type Pie = Slice & { note?: string }

const BAR_COLORS = { yellow: '#D9A400', magenta: '#B565D9', blue: '#4A90D9', green: '#3FB950' }

/**
 * Charts for the surface at hand: a donut with a legend where the surface
 * draws Svg (desktop, VS Code, mobile); `hasSvg` false on the terminal, where
 * the callers keep their text bars.
 */
export function chartKit(t: ElementTable, surface: string) {
  const { Box, Text } = t
  // The terminal's table names Svg too, and the terminal draws nothing for it.
  const Svg = surface !== 'terminal' && 'Svg' in t ? (t as { Svg: ElementConstructor<SvgProps> }).Svg : undefined
  const PieChart = (p: { k: string; title: string; slices: Pie[]; size?: number; center?: string; caption?: string; max?: number }) => {
    if (!Svg) return null
    const notes = new Map(p.slices.map(x => [x.label, x.note]))
    const slices = topSlices(p.slices, p.max ?? 6)
    if (!slices.length) return null
    const size = p.size ?? 104
    const total = slices.reduce((a, x) => a + x.value, 0) || 1
    return (
      <Box key={p.k} flexDirection="row" marginTop={1} alignItems="center">
        <Svg source={donutSvg(slices, { size, center: p.center, caption: p.caption })} alt={altOf(p.title, slices)} width={size} height={size} />
        <Box flexDirection="column" marginLeft={2}>
          {slices.map(x => (
            <Box key={`${p.k}-${x.label}`}>
              <Text>
                <Text color={x.color}>●</Text> {x.label.slice(0, 20)} <Text bold>{Math.round((x.value / total) * 100)}%</Text>
                {notes.get(x.label) ? <Text dimColor> {notes.get(x.label)}</Text> : null}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  }
  const Gauge = (p: { k: string; percent: number; caption: string; size?: number }) =>
    Svg ? <Svg key={p.k} source={gaugeSvg(p.percent, { size: p.size ?? 76, caption: p.caption })} alt={`${p.caption} ${p.percent}%`} width={p.size ?? 76} height={p.size ?? 76} /> : null
  // A row of bars: a drawing that shrinks with the pane, or text characters on the terminal.
  const Bars = (p: { k: string; title: string; values: number[]; color: keyof typeof BAR_COLORS } & BarsOptions) =>
    Svg
      ? <Svg key={p.k} source={barsSvg(p.values, BAR_COLORS[p.color], { label: p.label, ticks: p.ticks })} alt={`${p.title}: ${p.values.length} bars, the highest ${Math.round(Math.max(...p.values, 0))}`} />
      : <Text key={p.k} color={p.color}>{spark(p.values)}</Text>
  return { hasSvg: !!Svg, PieChart, Gauge, Bars }
}
