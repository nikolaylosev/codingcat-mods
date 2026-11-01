// The pane's History tab, from data the hooks file gathers.
import type { ElementConstructor, ElementTable, InputProps, SvgProps } from 'claude-code'
import type { HistScan, HistSession } from '../types'
import { chartKit } from './chart-kit'
import { HEAT, heatDays, heatmapSvg, heatmapText, streaks } from './charts'
import { byBranch } from './branches'
import { msPerDay, msPerHour } from './days'
import { ago, bar, day, DAY, dayKey, fmtMs, fmtN, pct } from './format'
import { bigPending, byProject, projectName, readingBig } from './history'
import { compare, efficiency, errKindsOf, levelColor, outputOf, per10, subShareOf, troubleOf } from './insights'
import { ERROR_TIPS } from './signals'
import type { ErrorKind } from './signals'
import { maskScope, maskSession } from './privacy'
import { agg, aggSince, inScope, merge, rootName, searchSessions } from './state'
import type { Agg, Scope } from './state'

export type HistoryData = {
  logs: HistScan
  now: number
  myId: string | undefined
  scope: Scope
  hidden: boolean
  query: string
  cols: number
  surface: string
  setScope: (scope: 'project' | 'all') => void
  setQuery: (query: string) => void
  rescan: () => void
  exportAs: (format: 'csv' | 'json') => void
}

export function historyView(table: ElementTable, { logs, now, myId, scope, hidden, query, cols: columns, surface, setScope, setQuery, rescan, exportAs }: HistoryData) {
  const { Box, Text, Button } = table
  const { hasSvg, PieChart, Bars } = chartKit(table, surface)
  const SvgEl = 'Svg' in table ? (table as { Svg: ElementConstructor<SvgProps> }).Svg : undefined
  const SvgOf = (p: { source: string; alt: string }) => (SvgEl ? <SvgEl source={p.source} alt={p.alt} /> : null)
  const shown = (xs: HistSession[]) => (hidden ? xs.map(maskSession) : xs)
  const all = shown(logs.sessions.filter(x => x.id !== myId && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0) && inScope(x, scope)))
  const sc = hidden ? maskScope(scope) : scope
  const scopeBar = (
    <Box flexDirection="row" marginBottom={1}>
      <Button key="scope-project" variant={sc.scope === 'project' ? 'primary' : 'secondary'} hotkey="p" label={`This project${sc.root ? ': ' + rootName(sc.root) : ''}`}
        onPress={() => setScope('project')} />
      <Text> </Text>
      <Button key="scope-all" variant={sc.scope === 'all' ? 'primary' : 'secondary'} hotkey="a" label="All projects"
        onPress={() => setScope('all')} />
    </Box>
  )
  const cols = Math.max(30, columns)
  const barW = Math.max(6, Math.min(20, cols - 34))
  const name = (x: HistSession) => projectName(x)
  const H = (p: { t: string; hint?: string }) => (
    <Box marginTop={1}><Text bold color="cyan">{p.t}</Text>{p.hint && <Text dimColor>  {p.hint}</Text>}</Box>
  )
  const pending = bigPending(logs, myId)
  const keptCount = logs.sessions.filter(x => x.archived).length
  const footer = (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        {logs.at ? `scanned ${ago(now, logs.at)} ago` : 'not scanned yet'}
        {pending ? ` · ${pending} large logs ${readingBig() ? 'reading…' : 'waiting'}` : ''}
        {keptCount ? ` · ${keptCount} kept from deleted logs` : ''}
      </Text>
      <Box flexDirection="row" marginTop={1}>
        <Button key="rescan" hotkey="r" label="Re-read logs" onPress={rescan} />
        <Text> </Text>
        <Button key="export-csv" hotkey="c" label="Export CSV" onPress={() => exportAs('csv')} />
        <Text> </Text>
        <Button key="export-json" hotkey="j" label="Export JSON" onPress={() => exportAs('json')} />
      </Box>
    </Box>
  )
  if (!all.length)
    return (
      <Box flexDirection="column">
        {scopeBar}
        <Text dimColor>{!logs.at ? 'Reading the logs…' : sc.scope === 'project' ? 'No past sessions of this project yet.' : 'No past sessions found in the logs.'}</Text>
        {footer}
      </Box>
    )

  const startOfToday = new Date(new Date(now).toDateString()).getTime()
  const periods = ([['Today', startOfToday], ['7 days', now - 7 * DAY], ['30 days', now - 30 * DAY], ['All', 0]] as const).map(
    ([label, since]) => [label, aggSince(all, since)] as const,
  )
  const perDay = msPerDay(all)
  const monthTicks = [{ at: 0, text: '30 days ago' }, { at: 29, text: 'today' }]
  const days: number[] = []
  for (let i = 29; i >= 0; i--) {
    days.push(perDay.get(dayKey(now - i * DAY)) ?? 0)
  }
  const byP = byProject(all)
  const projects = [...byP.entries()].map(([k, v]) => [k, agg(v)] as const).sort((a, b) => b[1].activeMs - a[1].activeMs).slice(0, 8)
  const maxP = Math.max(1, ...projects.map(p => p[1].activeMs))
  const branches = byBranch(all)
  const tools = merge(all, x => x.tools).slice(0, 10)
  const errs = Object.fromEntries(merge(all, x => x.toolErr))
  const maxT = Math.max(1, ...tools.map(t => t[1]))
  const models = merge(all, x => x.models).slice(0, 4)
  const totM = Math.max(1, models.reduce((a, m) => a + m[1], 0))
  const hours = msPerHour(all)
  const a = agg(all)
  const inT = all.reduce((t, x) => t + x.inp + x.cr + x.cw, 0)
  const recent = [...all].sort((p, q) => q.end - p.end).slice(0, 8)
  const money = (g: Agg) => (g.hasUsd ? ` · $${g.usd.toFixed(2)}` : '')

  return (
    <Box flexDirection="column">
      {scopeBar}
      {(() => {
        const every = shown(logs.sessions.filter(x => x.id !== myId && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0)))
        const found = searchSessions(every, query)
        const Input = 'Input' in table ? (table as { Input: ElementConstructor<InputProps> }).Input : undefined
        return (
          <Box flexDirection="column" marginBottom={1}>
            {Input ? (
              <Box flexDirection="row">
                <Input key="search" placeholder="Search sessions: project, branch, prompt, date" value={query} submitLabel="search"
                  onInput={v => setQuery(v)} onSubmit={v => setQuery(v)} />
                {query && <Text> </Text>}
                {query && <Button key="search-clear" label="Clear" onPress={() => setQuery('')} />}
              </Box>
            ) : (
              <Text dimColor>Search: /dashboard search &lt;words&gt;</Text>
            )}
            {query && <Text dimColor>{found.length} of {every.length} sessions match, across all projects</Text>}
            {found.slice(0, 15).map(x => (
              <Box key={`q-${x.id}`} flexDirection="column" marginTop={1}>
                <Text>
                  <Text dimColor>{day(x.start)}</Text> <Text bold>{projectName(x).slice(0, 18)}</Text>
                  {x.branch ? <Text color="magenta"> ⎇ {x.branch.slice(0, 24)}</Text> : null}
                </Text>
                {x.firstPrompt && <Text dimColor>  “{x.firstPrompt.slice(0, Math.max(30, cols - 6))}”</Text>}
                <Text dimColor>
                  {'  '}{x.prompts}p · {x.calls} calls{x.errors ? ` · ${x.errors} err` : ''} · {fmtMs(x.activeMs)}
                  {x.linesAdded ? ` · +${x.linesAdded}` : ''}{x.commits ? ` · ${x.commits} commits` : ''}{x.usd !== undefined ? ` · $${x.usd.toFixed(2)} API-eq.` : ''}
                </Text>
              </Box>
            ))}
            {found.length > 15 && <Text dimColor>…and {found.length - 15} more: narrow the search</Text>}
          </Box>
        )
      })()}
      <Text dimColor>{sc.scope === 'project' ? `${all.length} past sessions in ${sc.root || 'this project'}` : `${all.length} sessions in ${byP.size} projects`}</Text>

      <H t="Totals" />
      {periods.filter(([label, g]) => g.n > 0 || label === 'All').map(([label, g]) => (
        <Box key={`p-${label}`}>
          <Text>
            <Text bold>{label.padEnd(8)}</Text> {g.n} sess · {fmtMs(g.activeMs)} · {g.prompts} prompts · {g.calls} calls ·{' '}
            <Text color={g.errors ? 'red' : undefined}>{pct(g.errors, g.calls)}% err</Text>
            <Text dimColor>{money(g)}</Text>
          </Text>
        </Box>
      ))}

      {(() => {
        const ef = efficiency(all, now, dayKey)
        const w = ef.week
        const b = ef.before
        const line = (k: string, label: string, wv: number | undefined, bv: number | undefined, fmt: (v: number) => string, higherIsWorse = true) => {
          if (wv === undefined) return null
          const c = bv !== undefined ? compare(wv, bv, higherIsWorse) : undefined
          return (
            <Box key={k}>
              <Text>
                {label.padEnd(14)} <Text bold>{fmt(wv).padStart(7)}</Text>
                {c && c.arrow ? <Text color={levelColor(c.level)}> {c.arrow} {c.arrow === '≈' ? 'as before' : c.label}</Text> : null}
                {bv !== undefined ? <Text dimColor>  (before {fmt(bv)})</Text> : null}
              </Text>
            </Box>
          )
        }
        return (
          <Box flexDirection="column">
            <H t="API-equivalent cost & efficiency" />
            <Text dimColor>per prompt, last 7 days vs the 3 weeks before · $ at API list prices, not your subscription bill</Text>
            {w ? (
              <Box flexDirection="column">
                {ef.hasCost && line('e-usd', 'API-eq. cost', w.usd, b?.usd, v => `$${v.toFixed(2)}`)}
                {line('e-time', 'Model time', w.activeMs, b?.activeMs, v => fmtMs(v))}
                {line('e-calls', 'Tool calls', w.calls, b?.calls, v => v.toFixed(1))}
                {line('e-out', 'Output tokens', w.out, b?.out, v => fmtN(v))}
                {line('e-err', 'Errors', w.errRate * 100, b ? b.errRate * 100 : undefined, v => `${Math.round(v)}%`)}
              </Box>
            ) : (
              <Text dimColor>No sessions in the last 7 days.</Text>
            )}
            {ef.hasCost && ef.usd30 > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text>$ per day</Text>
                <Bars k="bars-usd" title="Dollars per day, 30 days" values={ef.usdPerDay} color="yellow" ticks={monthTicks} />
                <Text dimColor>
                  30 days ${ef.usd30.toFixed(2)} · {ef.activeDays} active days · ${(ef.usd30 / Math.max(1, ef.activeDays)).toFixed(2)} per active day · highest ${Math.max(...ef.usdPerDay).toFixed(2)}
                </Text>
              </Box>
            )}
            {ef.costly.length > 0 && <Text bold>Most expensive sessions (API-equivalent)</Text>}
            {ef.costly.map(({ s: x, usdPerPrompt }) => (
              <Box key={`c-${x.id}`}>
                <Text>
                  <Text color="yellow">${(x.usd ?? 0).toFixed(2).padStart(6)}</Text> <Text dimColor>{day(x.start)}</Text> {projectName(x).slice(0, 14)}
                  <Text dimColor> · {x.prompts}p{usdPerPrompt !== undefined ? ` · $${usdPerPrompt.toFixed(2)}/prompt` : ''} · {fmtMs(x.activeMs)}</Text>
                </Text>
              </Box>
            ))}
            {!ef.hasCost && <Text dimColor>Cost is not recorded in these logs (older Claude Code versions).</Text>}
          </Box>
        )
      })()}

      {(() => {
        const week = all.filter(x => x.end >= now - 7 * DAY)
        const before = all.filter(x => x.end < now - 7 * DAY && x.end >= now - 30 * DAY)
        const o = outputOf(all), ow = outputOf(week), ob = outputOf(before)
        const tr = troubleOf(all), tw = troubleOf(week), tb = troubleOf(before)
        const kinds = errKindsOf(all)
        const share = subShareOf(all)
        const cmpLine = (k: string, label: string, wv: number | undefined, bv: number | undefined, fmt: (v: number) => string, higherIsWorse: boolean) => {
          if (wv === undefined) return null
          const c = bv !== undefined && bv > 0 ? compare(Math.max(wv, 1e-9), bv, higherIsWorse) : undefined
          return (
            <Box key={k}>
              <Text>
                {label.padEnd(18)} <Text bold>{fmt(wv).padStart(6)}</Text>
                {c && c.arrow ? <Text color={levelColor(c.level)}> {c.arrow} {c.arrow === '≈' ? 'as before' : c.label}</Text> : null}
                {bv !== undefined ? <Text dimColor>  (before {fmt(bv)})</Text> : null}
              </Text>
            </Box>
          )
        }
        const topKind = kinds.find(([k]) => k !== 'other' && k !== 'non-zero exit')
        return (
          <Box flexDirection="column">
            <H t="Output" hint={o.isEstimated ? 'lines partly estimated from edits' : undefined} />
            <Text>
              <Text color="green">+{fmtN(o.added)}</Text> <Text color="red">−{fmtN(o.removed)}</Text> lines · {o.commits} commits · {o.prs} PRs
              {o.linesPerUsd !== undefined ? <Text dimColor> · {Math.round(o.linesPerUsd)} lines per API-eq. $</Text> : null}
            </Text>
            <Text dimColor>efficiency, last 7 days vs the 3 weeks before</Text>
            {cmpLine('o-lpm', 'lines / 1M tokens', ow.linesPerM, ob.linesPerM, v => v.toFixed(0), false)}
            {cmpLine('o-cpm', 'commits / 1M tok', ow.commitsPerM, ob.commitsPerM, v => v.toFixed(2), false)}
            {ow.linesPerUsd !== undefined && cmpLine('o-lpu', 'lines / API-eq. $', ow.linesPerUsd, ob.linesPerUsd, v => v.toFixed(0), false)}

            <H t="Trouble signals" hint="per 10 prompts, 7 days vs before" />
            {cmpLine('t-rej', 'rejected calls', per10(tw.rejections, tw.prompts), tb.prompts ? per10(tb.rejections, tb.prompts) : undefined, v => v.toFixed(1), true)}
            {cmpLine('t-int', 'interruptions', per10(tw.interrupts, tw.prompts), tb.prompts ? per10(tb.interrupts, tb.prompts) : undefined, v => v.toFixed(1), true)}
            {cmpLine('t-cmp', 'compactions', per10(tw.compactions, tw.prompts), tb.prompts ? per10(tb.compactions, tb.prompts) : undefined, v => v.toFixed(1), true)}
            {cmpLine('t-err', 'tool errors', per10(tw.errors, tw.prompts), tb.prompts ? per10(tb.errors, tb.prompts) : undefined, v => v.toFixed(1), true)}
            <Text dimColor>
              all time: {tr.rejections} rejected · {tr.interrupts} interrupted · {tr.compactions} compactions · {tr.apiErrors} API errors
              {tr.retryMs > 1000 ? ` · ${fmtMs(tr.retryMs)} lost to retries` : ''}
            </Text>

            {kinds.length > 0 && <H t="Errors by type" />}
            {kinds.length > 0 && hasSvg && (
              <PieChart k="pie-errkinds" title="Tool errors by type" center={`${kinds.reduce((a, k) => a + k[1], 0)}`} caption="errors"
                slices={kinds.map(([k, v]) => ({ label: k, value: v, color: k === 'rejected' ? '#F59E0B' : undefined, note: `${v}` }))} />
            )}
            {kinds.length > 0 && !hasSvg && kinds.slice(0, 8).map(([k, v]) => (
              <Box key={`hk-${k}`}><Text>{k.padEnd(18)} <Text color="red">{v}</Text></Text></Box>
            ))}
            {topKind && ERROR_TIPS[topKind[0] as ErrorKind] ? <Text dimColor>Most common, {topKind[0]}: {ERROR_TIPS[topKind[0] as ErrorKind]}</Text> : null}

            {share.sub > 0 && <H t="Main vs subagents" hint="tokens" />}
            {share.sub > 0 && hasSvg && (
              <PieChart k="pie-sub" title="Tokens: main loop vs subagents" center={fmtN(share.main + share.sub)} caption="tokens"
                slices={[{ label: 'main loop', value: share.main, color: '#4C8BF5', note: fmtN(share.main) }, { label: 'subagents', value: share.sub, color: '#8B5CF6', note: `${fmtN(share.sub)} · ${share.subCalls} calls` }]} />
            )}
            {share.sub > 0 && !hasSvg && <Text>main {fmtN(share.main)} · subagents {fmtN(share.sub)} <Text dimColor>({pct(share.sub, share.main + share.sub)}%)</Text></Text>}
          </Box>
        )
      })()}

      <H t="Active time per day · 30 days" />
      <Bars k="bars-active" title="Active time per day, 30 days" values={days} color="magenta" ticks={monthTicks} />
      <Text dimColor>today {fmtMs(days[days.length - 1] ?? 0)} · busiest {fmtMs(Math.max(...days))}</Text>

      {(() => {
        const weeks = hasSvg ? 53 : Math.max(10, Math.min(53, cols - 2))
        const grid = heatDays(d => perDay.get(dayKey(d.getTime())) ?? 0, new Date(now), weeks)
        const st = streaks(grid)
        const best = grid.flat().reduce((m, d) => (d.value > m.value ? d : m), { date: new Date(now), value: 0, level: 0 })
        return (
          <Box flexDirection="column">
            <H t="Your year" hint={`${st.activeDays} active days · streak ${st.current} · longest ${st.longest}`} />
            {hasSvg ? (
              <SvgOf source={heatmapSvg(grid)} alt={`Activity heatmap: ${st.activeDays} active days in the last year`} />
            ) : (
              heatmapText(grid).map((row, i) => <Box key={`hm-${i}`}><Text color="green">{row}</Text></Box>)
            )}
            <Text dimColor>
              less <Text color={HEAT[1]}>■</Text><Text color={HEAT[2]}>■</Text><Text color={HEAT[3]}>■</Text><Text color={HEAT[4]}>■</Text> more
              {best.value > 0 ? ` · busiest day ${dayKey(best.date.getTime())}: ${fmtMs(best.value)}` : ''}
            </Text>
          </Box>
        )
      })()}

      {sc.scope === 'all' && <H t="Projects" hint="share of active time" />}
      {sc.scope === 'all' && hasSvg && (
        <PieChart k="pie-projects" title="Active time by project" center={fmtMs(a.activeMs)} caption="active"
          slices={[...byP.entries()].map(([k, v]) => { const g = agg(v); return { label: k, value: g.activeMs, note: `${fmtMs(g.activeMs)} · ${g.n} sess` } })} />
      )}
      {sc.scope === 'all' && hasSvg && a.hasUsd && (
        <PieChart k="pie-cost" title="API-equivalent cost by project" center={`$${Math.round(a.usd)}`} caption="API-eq."
          slices={[...byP.entries()].map(([k, v]) => { const g = agg(v); return { label: k, value: g.usd, note: `$${g.usd.toFixed(2)}` } })} />
      )}
      {sc.scope === 'all' && !hasSvg && projects.map(([k, g]) => (
        <Box key={`pr-${k}`}>
          <Text>
            {k.slice(0, 16).padEnd(16)} <Text color="cyan">{bar(g.activeMs, maxP, barW)}</Text> {fmtMs(g.activeMs)}
            <Text dimColor> · {g.n} sess · {g.calls} calls{g.errors ? '' : ''}</Text>
            {g.errors > 0 && <Text color="red"> · {pct(g.errors, g.calls)}% err</Text>}
          </Text>
        </Box>
      ))}

      {branches.length > 0 && <H t="Branches" hint="newest first" />}
      {branches.slice(0, 8).map(b => (
        <Box key={`br-${b.project}-${b.branch}`}>
          <Text>
            <Text color="magenta">⎇ {(sc.scope === 'all' ? `${b.project}/${b.branch}` : b.branch).slice(0, 34)}</Text> {fmtMs(b.ms)}
            <Text dimColor> · {b.prompts}p{b.usd ? ` · $${b.usd.toFixed(2)}` : ''}{b.added || b.removed ? ` · +${b.added} −${b.removed}` : ''}{b.commits ? ` · ${b.commits} commits` : ''}</Text>
          </Text>
        </Box>
      ))}

      <H t="Tools" hint="share of calls" />
      {hasSvg && (
        <PieChart k="pie-tools" title="Tool calls by tool" center={fmtN(a.calls)} caption="calls"
          slices={merge(all, x => x.tools).map(([k, v]) => ({ label: k, value: v, note: errs[k] ? `${v} · ✗${errs[k]}` : `${v}` }))} />
      )}
      {hasSvg && (() => {
        const inp = all.reduce((t, x) => t + x.inp, 0), cr = all.reduce((t, x) => t + x.cr, 0), cw = all.reduce((t, x) => t + x.cw, 0), o = all.reduce((t, x) => t + x.out, 0)
        return (
          <Box flexDirection="column">
            <H t="Where tokens go" />
            <PieChart k="pie-tokens" title="Tokens" center={fmtN(inp + cr + cw + o)} caption="tokens"
              slices={[
                { label: 'cache read', value: cr, color: '#10B981', note: fmtN(cr) },
                { label: 'cache write', value: cw, color: '#F59E0B', note: fmtN(cw) },
                { label: 'uncached input', value: inp, color: '#EF4444', note: fmtN(inp) },
                { label: 'output', value: o, color: '#4C8BF5', note: fmtN(o) },
              ]} />
          </Box>
        )
      })()}
      {!hasSvg && tools.map(([k, v]) => (
        <Box key={`t-${k}`}>
          <Text>
            {k.slice(0, 16).padEnd(16)} <Text color="cyan">{bar(v, maxT, barW)}</Text> {v}
            {errs[k] ? <Text color="red"> ✗{errs[k]} ({pct(errs[k] ?? 0, v)}%)</Text> : <Text> </Text>}
          </Text>
        </Box>
      ))}

      <H t="Models" hint="share of replies" />
      {hasSvg && (
        <PieChart k="pie-models" title="Replies by model" slices={merge(all, x => x.models).map(([k, v]) => ({ label: k.replace(/^claude-/, ''), value: v, note: `${v}` }))} />
      )}
      {!hasSvg && models.map(([k, v]) => (
        <Box key={`m-${k}`}>
          <Text>
            {k.slice(0, 22).padEnd(22)} <Text color="blue">{bar(v, totM, barW)}</Text> {pct(v, totM)}%
          </Text>
        </Box>
      ))}

      <H t="When you work" />
      <Bars k="bars-hours" title="Active time per hour of the day" values={hours} color="green" ticks={[0, 6, 12, 18, 23].map(h => ({ at: h, text: `${h}h` }))} />
      <Text dimColor>0h → 23h{Math.max(...hours) > 0 ? ` · busiest ${hours.indexOf(Math.max(...hours))}h, ${fmtMs(Math.max(...hours))}` : ''}</Text>

      <H t="Habits" />
      <Text>avg session {fmtMs(a.activeMs / all.length)} · {(a.prompts / all.length).toFixed(1)} prompts · {(a.calls / all.length).toFixed(0)} calls</Text>
      <Text>{(a.calls / Math.max(1, a.prompts)).toFixed(1)} calls and {fmtN(a.out / Math.max(1, a.prompts))} out tokens per prompt</Text>
      <Text>cache hit {pct(all.reduce((t, x) => t + x.cr, 0), inT)}%</Text>

      <H t="Recent sessions" />
      {recent.map(x => (
        <Box key={`r-${x.id}`}>
          <Text>
            <Text dimColor>{day(x.start)}</Text> {name(x).slice(0, 16)} · {x.prompts}p · {x.calls} calls ·{' '}
            <Text color={x.errors ? 'red' : undefined}>{x.errors} err</Text> · {fmtMs(x.activeMs)}
            {x.usd !== undefined && <Text dimColor> · ${x.usd.toFixed(2)}</Text>}
          </Text>
        </Box>
      ))}
      {footer}
    </Box>
  )
}
