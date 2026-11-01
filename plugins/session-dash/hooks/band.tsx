// The band above the prompt: what it says, from data the hooks file gathers.
import type { HistScan, HistSession, Stats } from '../types'
import { dayKey, daysOf, sinceDay } from './days'
import { padR } from './format'
import { compare, currentOf, dur, findings, levelColor, levelIcon, normOf, promptsLeft } from './insights'
import type { Norm, PerPrompt } from './insights'
import type { LimitView } from './limits'
import { inScope, summarize } from './state'
import type { Scope, Usage } from './state'
import type { ElementTable } from 'claude-code'

type BandPart = { text: string; color?: string }
export const OPEN_LABEL = 'Dashboard'
const fillColor = (p: number) => (p >= 80 ? 'red' : p >= 60 ? 'yellow' : undefined)

/** What the band says, the most pressing first; a figure with nothing to say yet is left out. */
function bandParts(s: Stats, ctx: number | undefined, limits: LimitView[], spent: number | undefined): BandPart[] {
  const c = summarize(s)
  const parts: BandPart[] = []
  const left = promptsLeft(s.ctxTrail, s.ctxLimit)
  const room = left === undefined ? '' : `, ~${left} prompt${left === 1 ? '' : 's'} left`
  if (ctx !== undefined) parts.push({ text: `Context ${ctx}%${room}`, color: fillColor(ctx) })
  for (const l of limits) {
    const name = l.kind === 'five_hour' ? '5h' : l.kind === 'seven_day' ? '7d' : l.label
    const pace = l.pct < 100 && l.runsOut && l.fullInMs !== undefined ? `, full in ${dur(l.fullInMs)}`
      : l.resetsInMs !== undefined ? `, reset ${dur(l.resetsInMs)}` : ''
    parts.push({ text: `${name} ${Math.round(l.pct)}%${pace}`, color: l.runsOut ? 'red' : fillColor(l.pct) })
  }
  if (spent !== undefined && spent >= 0.005) parts.push({ text: `$${spent.toFixed(2)}` })
  if (c.errors) parts.push({ text: `${c.errors} err`, color: 'red' })
  // Last, so that it coming and going does not move the figures before it.
  const doing = runningNow(s)
  if (doing) parts.push({ text: doing })
  return parts
}

/** The calls still open; one left over from a turn that has ended does not count. */
function runningNow(s: Stats): string | undefined {
  const since = s.turns.filter(t => !t.isSub).at(-1)?.at ?? 0
  const open = s.recent.filter(x => x.status === 'run' && x.at >= since)
  return open.length > 1 ? `${open.length} tools running…` : open[0] && `${open[0].tool} running…`
}

/** The second row when nothing needs attention: the day so far across sessions. */
function todayParts(past: HistSession[], now: number, activeMs: number, spentHere: number | undefined): BandPart[] {
  const key = dayKey(now)
  const today = past.filter(x => daysOf(x)[key])
  const here = sinceDay(today, now)
  const ms = here.ms + activeMs
  if (!ms) return []
  if (!today.length) return [{ text: `Today ${dur(ms)}` }]
  const spent = here.usd + (spentHere ?? 0)
  return [{ text: `Today ${dur(ms)}` }, { text: `${today.length + 1} sessions` }, ...(spent ? [{ text: `$${spent.toFixed(2)}` }] : [])]
}

/** What runs furthest above the usual prompt in this session; a few prompts say too little. */
function normParts(cur: PerPrompt | undefined, norm: Norm | undefined): BandPart[] {
  if (!cur || !norm || cur.prompts < 3) return []
  const rows = [['Tokens', compare(cur.out, norm.out)] as const, ['Calls', compare(cur.calls, norm.calls)] as const, ['Time', compare(cur.activeMs, norm.activeMs)] as const]
    .filter(([, c]) => c.ratio > 1.25)
    .sort((a, b) => b[1].ratio - a[1].ratio)
  const top = rows[0]
  if (!top) return []
  return [{ text: `${top[0]}/prompt ${top[1].label}`, color: levelColor(top[1].level) }]
}

/** Keeps what fits the width, in order of importance. */
function fitBand(parts: BandPart[], cols: number): BandPart[] {
  let w = 2 // the mark in front
  return parts.filter((p, i) => {
    const n = p.text.length + (i ? 3 : 0)
    if (w + n > cols) return false
    w += n
    return true
  })
}

export type BandData = {
  s: Stats
  now: number
  usage: Usage | undefined
  limits: LimitView[]
  logs: HistScan
  myId: string | undefined
  sc: Scope
  cols: number
  onOpen: () => void
}

export function bandView({ Box, Button, Text }: ElementTable, { s, now, usage, limits, logs, myId, sc, cols, onOpen }: BandData) {
  const ctx = usage?.context.percent
  // The usage total of a resumed session opens with what it cost before.
  const spent = usage?.cost && s.costAtStart !== undefined ? usage.cost.usd - s.costAtStart : usage?.cost?.usd
  const parts = fitBand(bandParts(s, ctx, limits, spent), cols)
  const past = logs.sessions.filter(x => x.id !== myId && !x.tooBig && (x.prompts > 0 || x.calls > 0))
  const norm = normOf(past.filter(x => inScope(x, sc)), past)
  const cur = currentOf(s, usage?.cost?.usd)
  const info = fitBand([...todayParts(past, now, summarize(s).activeMs, spent), ...normParts(cur, norm)], cols)
  // The first row already shows the context and the limits, in color when they run short.
  const top = findings({ s, cur, max: 1 })[0]
  const note = top && (top.level === 'bad' || top.level === 'warn') ? top : undefined
  const noteText = note ? `${note.text}${note.tip ? ` · ${note.tip}` : ''}` : ''
  const row = (mark: string, xs: BandPart[]) => (
    <Text>
      <Text dimColor>{mark} </Text>
      {xs.map((p, i) => (
        <Text key={`b-${p.text}`}>
          <Text dimColor>{i ? ' · ' : ''}</Text>
          <Text color={p.color} dimColor={!p.color}>{p.text}</Text>
        </Text>
      ))}
    </Text>
  )
  const room = Math.max(10, cols - 2)
  return (
    <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="flex-start">
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {row('◆', parts)}
        {!note && info.length > 0 && row(levelIcon('info'), info)}
        {note && (
          <Text>
            <Text color={levelColor(note.level)}>{levelIcon(note.level)}</Text> {noteText.length > room ? padR(noteText, room) : noteText}
          </Text>
        )}
      </Box>
      <Box marginLeft={1} flexShrink={0}>
        <Button key="band-open" plain dimColor variant="secondary" label={OPEN_LABEL} onPress={() => onOpen()} />
      </Box>
    </Box>
  )
}
