// The side pane's tabs and its Session tab, from data the hooks file gathers.
import type { HistScan, Stats, TurnRow } from '../types'
import { chartKit } from './chart-kit'
import { ago, bar, day, fmtMs, fmtN, paceText, pct } from './format'
import { compare, currentOf, dur, findings, levelColor, levelIcon, normOf } from './insights'
import type { Insight } from './insights'
import { maskScope } from './privacy'
import { inScope, rootName, summarize } from './state'
import type { ElementTable } from 'claude-code'
import type { LimitView } from './limits'
import type { Scope, Usage } from './state'

export type TabsData = {
  view: 'session' | 'history'
  hidden: boolean
  setView: (view: 'session' | 'history') => void
  togglePrivate: () => void
}

export function tabsView({ Box, Text, Button }: ElementTable, { view, hidden, setView, togglePrivate }: TabsData) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Button key="tab-session" variant={view === 'session' ? 'primary' : 'secondary'} hotkey="s" label="Session"
        onPress={() => setView('session')} />
      <Text> </Text>
      <Button key="tab-history" variant={view === 'history' ? 'primary' : 'secondary'} hotkey="h" label="History"
        onPress={() => setView('history')} />
      <Text> </Text>
      <Button key="private" variant={hidden ? 'primary' : 'secondary'} hotkey="v" label={hidden ? 'Private: on' : 'Private: off'}
        onPress={() => togglePrivate()} />
    </Box>
  )
}

export type SessionData = {
  tabs: ReturnType<typeof tabsView>
  s: Stats
  showDetails: boolean
  now: number
  usage: Usage
  limits: LimitView[]
  logs: HistScan
  myId: string | undefined
  scope: Scope
  hidden: boolean
  cols: number
  surface: string
  toggleDetails: () => void
  resetStats: () => void
}

export function sessionView(table: ElementTable, { tabs, s, showDetails, now, usage, limits, logs, myId, scope, hidden, cols: columns, surface, toggleDetails, resetStats }: SessionData) {
  const { Box, Text, Button } = table
  const { hasSvg, PieChart, Gauge, Bars } = chartKit(table, surface)
  const usable = logs.sessions.filter(x => x.id !== myId && !x.tooBig && (x.prompts > 0 || x.calls > 0))
  const past = usable.filter(x => inScope(x, scope)).sort((a, b) => b.end - a.end)
  const sc = hidden ? maskScope(scope) : scope
  const norm = normOf(past, usable)
  const cur = currentOf(s, usage.cost?.usd)
  const ctxPct = usage.context.percent
  const notes = findings({ s, cur, norm, contextPercent: ctxPct, limits })
  const cols = Math.max(30, columns)
  const barW = Math.max(6, Math.min(24, cols - 30))

  const mainTurns = s.turns.filter(t => !t.isSub)
  const durations = mainTurns.slice(-(cols - 2)).map(t => t.ms)
  const outputs = mainTurns.slice(-(cols - 2)).map(t => t.out)
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length)
  const sum0 = summarize(s, usage.cost?.usd)
  const tools = [...s.tools].sort((a, b) => b.count - a.count).slice(0, 10)
  const maxCount = Math.max(1, ...tools.map(t => t.count))
  const recent = s.recent.slice(-8).reverse()
  const spent = usage.cost && s.costAtStart !== undefined ? usage.cost.usd - s.costAtStart : undefined

  const H = (p: { t: string; hint?: string }) => (
    <Box marginTop={1}>
      <Text bold color="cyan">{p.t}</Text>
      {p.hint && <Text dimColor>  {p.hint}</Text>}
    </Box>
  )
  // One row of "this session per prompt" against the norm.
  const Row = (p: { k: string; label: string; value: string; c?: ReturnType<typeof compare>; norm?: string }) => (
    <Box key={p.k}>
      <Text>
        {p.label.padEnd(14)} <Text bold>{p.value.padStart(7)}</Text>
        {p.c && p.c.arrow ? (
          <Text color={levelColor(p.c.level)}> {p.c.arrow} {p.c.label}</Text>
        ) : null}
        {p.norm ? <Text dimColor>  (usual {p.norm})</Text> : null}
      </Text>
    </Box>
  )
  const rows: { k: string; label: string; value: string; c?: ReturnType<typeof compare>; norm?: string }[] = []
  if (cur) {
    if (cur.usd !== undefined)
      rows.push({ k: 'usd', label: 'API-eq. cost', value: `$${cur.usd.toFixed(2)}`, c: norm?.usd !== undefined ? compare(cur.usd, norm.usd) : undefined, norm: norm?.usd !== undefined ? `$${norm.usd.toFixed(2)}` : undefined })
    rows.push({ k: 'time', label: 'Model time', value: fmtMs(cur.activeMs), c: norm ? compare(cur.activeMs, norm.activeMs) : undefined, norm: norm ? fmtMs(norm.activeMs) : undefined })
    rows.push({ k: 'calls', label: 'Tool calls', value: cur.calls.toFixed(1), c: norm ? compare(cur.calls, norm.calls) : undefined, norm: norm ? norm.calls.toFixed(1) : undefined })
    rows.push({ k: 'out', label: 'Output tokens', value: fmtN(cur.out), c: norm ? compare(cur.out, norm.out) : undefined, norm: norm ? fmtN(norm.out) : undefined })
    if (cur.calls > 0)
      rows.push({ k: 'err', label: 'Errors', value: `${Math.round(cur.errRate * 100)}%`, c: norm && norm.errRate > 0 ? compare(Math.max(cur.errRate, 0.0001), norm.errRate) : undefined, norm: norm ? `${Math.round(norm.errRate * 100)}%` : undefined })
  }
  const facts = [
    s.prompts ? `${s.prompts} prompts` : '',
    sum0.toolCalls ? `${sum0.toolCalls} calls` : '',
    sum0.activeMs ? fmtMs(sum0.activeMs) + ' working' : '',
    spent !== undefined && spent > 0.005 ? `$${spent.toFixed(2)} API-eq. since open` : '',
    usage.cost ? `$${usage.cost.usd.toFixed(2)} API-eq. session total` : '',
  ].filter(Boolean)

  return (
    <Box flexDirection="column">
      {tabs}
      {hasSvg && ctxPct !== undefined ? (
        <Box flexDirection="row" alignItems="center">
          <Gauge k="ctx-gauge" percent={ctxPct} caption="context" />
          <Box flexDirection="column" marginLeft={2}>
            <Text>Context <Text bold>{ctxPct}%</Text> <Text dimColor>of {fmtN(usage.context.window)}{usage.context.tokens ? ` · ${fmtN(usage.context.tokens)} used` : ''}</Text></Text>
            {facts.map(f => <Box key={`f-${f}`}><Text dimColor>{f}</Text></Box>)}
            {!facts.length && <Text dimColor>started {s.startedAt ? ago(now, s.startedAt) : '?'} ago, nothing yet</Text>}
          </Box>
        </Box>
      ) : (
        <Text dimColor>{facts.length ? facts.join(' · ') : `started ${s.startedAt ? ago(now, s.startedAt) : '?'} ago, nothing yet`}</Text>
      )}
      {!hasSvg && ctxPct !== undefined && (
        <Text>
          Context <Text color={ctxPct >= 80 ? 'red' : ctxPct >= 60 ? 'yellow' : 'green'}>{bar(ctxPct, 100, barW)}</Text> {ctxPct}%
          <Text dimColor> of {fmtN(usage.context.window)}</Text>
        </Text>
      )}

      {limits.length > 0 && <H t="Plan limits" />}
      {limits.length > 0 && hasSvg && (
        <Box flexDirection="row" flexWrap="wrap">
          {limits.map(l => (
            <Box key={`lim-${l.kind}`} flexDirection="row" alignItems="center" marginRight={2} marginBottom={1}>
              <Gauge k={`g-${l.kind}`} percent={l.pct} caption={l.kind === 'five_hour' ? '5h' : l.kind === 'seven_day' ? '7d' : 'limit'} size={64} />
              <Box flexDirection="column" marginLeft={1}>
                <Text bold>{l.label}</Text>
                {l.resetsInMs !== undefined && <Text dimColor>resets in {dur(l.resetsInMs)}</Text>}
                <Text color={l.runsOut ? 'red' : undefined} dimColor={!l.runsOut}>{paceText(l)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
      {limits.length > 0 && !hasSvg && limits.map(l => (
        <Box key={`lim-${l.kind}`}>
          <Text>
            {l.label.padEnd(8)} <Text color={l.pct >= 80 || l.runsOut ? 'red' : l.pct >= 60 ? 'yellow' : 'green'}>{bar(l.pct, 100, barW)}</Text> {Math.round(l.pct)}%
            <Text dimColor>{l.resetsInMs !== undefined ? ` · resets in ${dur(l.resetsInMs)}` : ''} · {paceText(l)}</Text>
          </Text>
        </Box>
      ))}

      {((s.linesAdded ?? 0) > 0 || (s.commits ?? 0) > 0 || (s.prs ?? 0) > 0) && (
        <Box marginTop={1}>
          <Text>
            Output <Text color="green">+{s.linesAdded ?? 0}</Text> <Text color="red">−{s.linesRemoved ?? 0}</Text> lines
            {' · '}{s.commits ?? 0} commits{(s.prs ?? 0) > 0 ? ` · ${s.prs} PRs` : ''}
            {spent !== undefined && spent > 0.05 && (s.linesAdded ?? 0) > 0 ? <Text dimColor> · {Math.round((s.linesAdded ?? 0) / spent)} lines per API-eq. $</Text> : null}
          </Text>
        </Box>
      )}

      {notes.length > 0 && <H t="What stands out" />}
      {notes.map((n: Insight, i: number) => (
        <Box key={`n-${i}`} flexDirection="column">
          <Text><Text color={levelColor(n.level)}>{levelIcon(n.level)}</Text> {n.text}</Text>
          {n.tip && <Text dimColor>   {n.tip}</Text>}
        </Box>
      ))}

      {rows.length > 0 && (
        <H t="Per prompt" hint={norm ? `vs your norm: ${norm.sessions} sessions${norm.isAllProjects ? ', all projects' : ''}` : 'norm appears after a few past sessions'} />
      )}
      {rows.map(r => <Row {...r} />)}
      {!cur && <Text dimColor>Per-prompt figures appear after your first prompt.</Text>}

      <Box flexDirection="row" marginTop={1}>
        <Button key="details" hotkey="d" label={showDetails ? 'Hide details' : 'Details'}
          onPress={() => toggleDetails()} />
      </Box>

      {showDetails && (
        <Box flexDirection="column">
          {mainTurns.length > 1 && <H t="Turn duration" hint={`last ${Math.min(mainTurns.length, cols - 2)}`} />}
          {mainTurns.length > 1 && <Bars k="bars-turn-ms" title="Turn duration" values={durations} color="magenta" label={fmtMs} />}
          {mainTurns.length > 1 && <Text dimColor>latest {fmtMs(durations[durations.length - 1] ?? 0)} · average {fmtMs(mean(durations))} · longest {fmtMs(Math.max(...durations))}</Text>}
          {mainTurns.length > 1 && <H t="Output tokens per turn" />}
          {mainTurns.length > 1 && <Bars k="bars-turn-out" title="Output tokens per turn" values={outputs} color="blue" label={fmtN} />}
          {mainTurns.length > 1 && <Text dimColor>latest {fmtN(outputs[outputs.length - 1] ?? 0)} · average {fmtN(mean(outputs))} · highest {fmtN(Math.max(...outputs))}</Text>}

          {s.turns.length > 0 && hasSvg && (() => {
            const inp = s.turns.reduce((a, t) => a + t.inp, 0), cr = s.turns.reduce((a, t) => a + t.cacheRead, 0)
            const cw = s.turns.reduce((a, t) => a + t.cacheWrite, 0), o = s.turns.reduce((a, t) => a + t.out, 0)
            return (
              <Box flexDirection="column">
                <H t="Where tokens go" />
                <PieChart k="s-pie-tokens" title="Tokens this session" center={fmtN(inp + cr + cw + o)} caption="tokens"
                  slices={[
                    { label: 'cache read', value: cr, color: '#10B981', note: fmtN(cr) },
                    { label: 'cache write', value: cw, color: '#F59E0B', note: fmtN(cw) },
                    { label: 'uncached input', value: inp, color: '#EF4444', note: fmtN(inp) },
                    { label: 'output', value: o, color: '#4C8BF5', note: fmtN(o) },
                  ]} />
              </Box>
            )
          })()}
          {Object.keys(s.errKinds ?? {}).length > 0 && <H t="Errors by type" />}
          {Object.keys(s.errKinds ?? {}).length > 0 && hasSvg && (
            <PieChart k="s-pie-errs" title="Errors by type" center={`${Object.values(s.errKinds ?? {}).reduce((a, v) => a + v, 0)}`} caption="errors"
              slices={Object.entries(s.errKinds ?? {}).map(([k, v]) => ({ label: k, value: v, color: k === 'rejected' ? '#F59E0B' : undefined, note: `${v}` }))} />
          )}
          {Object.keys(s.errKinds ?? {}).length > 0 && !hasSvg && Object.entries(s.errKinds ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <Box key={`ek-${k}`}><Text>{k.padEnd(18)} <Text color="red">{v}</Text></Text></Box>
          ))}
          {s.turns.some(t => t.isSub) && (() => {
            const tok = (t: TurnRow) => t.inp + t.cacheRead + t.cacheWrite + t.out
            const sub = s.turns.filter(t => t.isSub).reduce((a, t) => a + tok(t), 0)
            const main = s.turns.filter(t => !t.isSub).reduce((a, t) => a + tok(t), 0)
            return (
              <Box flexDirection="column">
                <H t="Main vs subagents" hint="tokens" />
                {hasSvg ? (
                  <PieChart k="s-pie-sub" title="Tokens: main loop vs subagents" center={fmtN(main + sub)} caption="tokens"
                    slices={[{ label: 'main loop', value: main, color: '#4C8BF5', note: fmtN(main) }, { label: 'subagents', value: sub, color: '#8B5CF6', note: fmtN(sub) }]} />
                ) : (
                  <Text>main {fmtN(main)} · subagents {fmtN(sub)} <Text dimColor>({pct(sub, main + sub)}%)</Text></Text>
                )}
              </Box>
            )
          })()}
          {tools.length > 0 && <H t="Tools" hint={hasSvg ? 'share of calls · count · avg time · errors' : 'calls · avg time · errors'} />}
          {tools.length > 0 && hasSvg && (
            <PieChart k="s-pie-tools" title="Tool calls this session" center={`${sum0.toolCalls}`} caption="calls"
              slices={s.tools.map(t => ({ label: t.name, value: t.count, note: `${t.count} · ${fmtMs(t.ms / Math.max(1, t.count))}${t.errors ? ` · ✗${t.errors}` : ''}` }))} />
          )}
          {!hasSvg && tools.map(t => (
            <Box key={`tool-${t.name}`}>
              <Text>
                {t.name.slice(0, 14).padEnd(14)} <Text color="cyan">{bar(t.count, maxCount, barW)}</Text> {String(t.count).padStart(3)}
                <Text dimColor> {fmtMs(t.ms / Math.max(1, t.count))}</Text>
                {t.errors > 0 && <Text color="red"> ✗{t.errors}</Text>}
              </Text>
            </Box>
          ))}

          {recent.length > 0 && <H t="Recent calls" />}
          {recent.map(r => (
            <Box key={`rc-${r.id}`}>
              <Text dimColor={r.status === 'ok'}>
                <Text color={r.status === 'err' ? 'red' : r.status === 'deny' ? 'yellow' : r.status === 'run' ? 'cyan' : undefined}>
                  {r.status === 'ok' ? '✓' : r.status === 'err' ? '✗' : r.status === 'deny' ? '⊘' : '…'}
                </Text>{' '}
                {r.tool.slice(0, 28)} <Text dimColor>{r.status === 'run' ? 'running' : fmtMs(r.ms)} · {ago(now, r.at)} ago</Text>
              </Text>
            </Box>
          ))}

          {past.length > 0 && <H t={sc.scope === 'project' && sc.root ? `Past sessions · ${rootName(sc.root)}` : 'Past sessions'} />}
          {past.slice(0, 5).map(x => (
            <Box key={`ps-${x.id}`}>
              <Text>
                <Text dimColor>{day(x.start)}</Text> {x.prompts}p · {x.calls} calls
                {x.errors > 0 && <Text color="red"> · {x.errors} err</Text>} · {fmtMs(x.activeMs)}
                {x.usd !== undefined && <Text dimColor> · ${x.usd.toFixed(2)}</Text>}
              </Text>
            </Box>
          ))}

          <Box flexDirection="row" marginTop={1}>
            <Button key="reset" label="Reset this session's stats"
              onPress={() => resetStats()} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
