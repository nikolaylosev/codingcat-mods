// The plain text reports /session-dash answers with.
import type { HistScan, PastSession, Stats, TurnRow } from '../types'
import { msPerDay, msPerHour, msPerWeekday } from './days'
import { ago, bar, clock, count, DAY, day, dayKey, fmtMs, fmtN, paceText, pad, padR, pct, spark } from './format'
import { byBranch } from './branches'
import { bigPending, byProject, projectKey, projectName, readingBig } from './history'
import { compare, dur, efficiency, errKindsOf, levelIcon, outputOf, per10, subShareOf, troubleOf } from './insights'
import type { Insight, Norm, PerPrompt } from './insights'
import type { LimitView } from './limits'
import { ERROR_TIPS } from './signals'
import type { ErrorKind } from './signals'
import { maskScope, maskSession } from './privacy'
import { SKILLS_NOTE, skillList, skillRows } from './skills'
import { agg, aggSince, FLOOR_NOTE, inScope, isFloor, merge, rootName, summarize, usdText } from './state'
import type { Scope } from './state'

export function historyReport(h: HistScan, currentId: string | undefined, now: number, detailed: boolean, scope: Scope = { scope: 'all', root: '' }, hidden = false): string {
  const L: string[] = []
  const hr = (title: string) => L.push('', `── ${title} ${'─'.repeat(Math.max(3, 44 - title.length))}`)
  const found = h.sessions.filter(x => x.id !== currentId && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0) && inScope(x, scope))
  const all = hidden ? found.map(maskSession) : found
  const sc = hidden ? maskScope(scope) : scope
  const projects = new Set(all.map(projectKey))
  hr(sc.scope === 'project' && sc.root ? `Project ${rootName(sc.root)} · ${all.length} sessions` : `All sessions · ${all.length} in ${projects.size} projects`)
  if (h.error) L.push(`  ${h.error}`)
  if (!all.length) {
    L.push(h.at ? '  No past sessions found in the logs.' : '  Reading the logs… run /session-dash again in a moment.')
    return L.join('\n')
  }
  const startOfToday = new Date(new Date(now).toDateString()).getTime()
  L.push(`  period        sess  prompts  calls  err%     out    active  api-eq $`)
  let floor = false
  for (const [label, since] of [['today', startOfToday], ['7 days', now - 7 * DAY], ['30 days', now - 30 * DAY], ['all', 0]] as const) {
    const a = aggSince(all, since)
    floor ||= isFloor(a)
    L.push(`  ${padR(label, 12)} ${pad(a.n, 5)} ${pad(a.prompts, 8)} ${pad(a.calls, 6)} ${pad(pct(a.errors, a.calls) + '%', 5)} ${pad(fmtN(a.out), 7)} ${pad(fmtMs(a.activeMs), 9)} ${pad(usdText(a), 8)}`)
  }
  if (floor) L.push(`  ${FLOOR_NOTE}`)

  const perDay = msPerDay(all)
  const days: number[] = []
  for (let i = 29; i >= 0; i--) {
    days.push(perDay.get(dayKey(now - i * DAY)) ?? 0)
  }
  L.push('', `  active / day (30d)  ${spark(days)}  today ${fmtMs(days[days.length - 1] ?? 0)}`)

  const recent = [...all].sort((a, b) => b.end - a.end).slice(0, detailed ? 15 : 6)
  hr('Recent sessions')
  L.push(`  started      project           prompts calls err     out   active  api-eq$`)
  for (const x of recent)
    L.push(`  ${day(x.start)}  ${padR(projectName(x), 16)} ${pad(x.prompts, 6)} ${pad(x.calls, 5)} ${pad(x.errors || '·', 3)} ${pad(fmtN(x.out), 7)} ${pad(fmtMs(x.activeMs), 8)} ${pad(x.usd !== undefined ? '$' + x.usd.toFixed(2) : '—', 7)}`)

  if (detailed) {
    const ef = efficiency(all, now, dayKey)
    hr('API-equivalent cost & efficiency · per prompt, 7d vs 3 weeks before')
    L.push('  API-equivalent: Claude Code\'s own figure at API list prices, not what a subscription bills')
    const w = ef.week, b = ef.before
    const ln = (label: string, wv: number | undefined, bv: number | undefined, fmt: (v: number) => string) => {
      if (wv === undefined) return
      const c = bv !== undefined ? compare(wv, bv) : undefined
      L.push(`  ${padR(label, 14)} ${pad(fmt(wv), 8)}  ${c && c.arrow ? `${c.arrow} ${c.arrow === '≈' ? 'as before' : c.label}` : ''}${bv !== undefined ? `  (before ${fmt(bv)})` : ''}`)
    }
    if (!w) L.push('  no sessions in the last 7 days')
    else {
      if (ef.hasCost) ln('cost', w.usd, b?.usd, v => '$' + v.toFixed(2))
      ln('model time', w.activeMs, b?.activeMs, fmtMs)
      ln('tool calls', w.calls, b?.calls, v => v.toFixed(1))
      ln('output tokens', w.out, b?.out, fmtN)
      ln('errors', w.errRate * 100, b ? b.errRate * 100 : undefined, v => Math.round(v) + '%')
    }
    if (ef.hasCost && ef.usd30 > 0) {
      L.push('', `  $ per day (30d)  ${spark(ef.usdPerDay)}`)
      const plus = ef.usd30Floor ? '+' : ''
      L.push(`  30 days $${ef.usd30.toFixed(2)}${plus} · ${count(ef.activeDays, 'active day')} · $${(ef.usd30 / Math.max(1, ef.activeDays)).toFixed(2)}${plus} per active day`)
    }
    if (ef.costly.length) {
      L.push('', '  most expensive (API-equivalent):')
      for (const { s: x, usdPerPrompt } of ef.costly)
        L.push(`  ${pad('$' + (x.usd ?? 0).toFixed(2), 8)}  ${day(x.start)}  ${padR(projectName(x), 16)} ${x.prompts}p${usdPerPrompt !== undefined ? ` · $${usdPerPrompt.toFixed(2)}/prompt` : ''}`)
    }
    {
      const week = all.filter(x => x.end >= now - 7 * DAY)
      const before = all.filter(x => x.end < now - 7 * DAY && x.end >= now - 30 * DAY)
      const o = outputOf(all), ow = outputOf(week), ob = outputOf(before)
      hr(`Output${o.isEstimated ? ' (lines partly estimated)' : ''}`)
      L.push('  Lines count Edit and Write only: edits made through shell commands are not seen.')
      L.push(`  +${o.added} −${o.removed} lines · ${count(o.commits, 'commit')} · ${count(o.prs, 'PR')}${o.linesPerUsd !== undefined ? ` · ${Math.round(o.linesPerUsd)} lines per API-eq. $` : ''}`)
      const ln = (label: string, wv: number | undefined, bv: number | undefined, fmt: (v: number) => string, worse: boolean) => {
        if (wv === undefined) return
        const c = bv ? compare(Math.max(wv, 1e-9), bv, worse) : undefined
        L.push(`  ${padR(label, 18)} ${pad(fmt(wv), 7)}  ${c && c.arrow ? `${c.arrow} ${c.arrow === '≈' ? 'as before' : c.label}` : ''}${bv !== undefined ? `  (before ${fmt(bv)})` : ''}`)
      }
      ln('lines / 1M tokens', ow.linesPerM, ob.linesPerM, v => v.toFixed(0), false)
      ln('commits / 1M tok', ow.commitsPerM, ob.commitsPerM, v => v.toFixed(2), false)
      const tw = troubleOf(week), tb = troubleOf(before), tr = troubleOf(all)
      hr('Trouble signals · per 10 prompts, 7d vs before')
      ln('rejected calls', per10(tw.rejections, tw.prompts), tb.prompts ? per10(tb.rejections, tb.prompts) : undefined, v => v.toFixed(1), true)
      ln('interruptions', per10(tw.interrupts, tw.prompts), tb.prompts ? per10(tb.interrupts, tb.prompts) : undefined, v => v.toFixed(1), true)
      ln('compactions', per10(tw.compactions, tw.prompts), tb.prompts ? per10(tb.compactions, tb.prompts) : undefined, v => v.toFixed(1), true)
      ln('tool errors', per10(tw.errors, tw.prompts), tb.prompts ? per10(tb.errors, tb.prompts) : undefined, v => v.toFixed(1), true)
      L.push(`  all time: ${tr.rejections} rejected · ${tr.interrupts} interrupted · ${tr.compactions} compactions · ${tr.apiErrors} API errors${tr.retryMs > 1000 ? ` · ${fmtMs(tr.retryMs)} lost to retries` : ''}`)
      const kinds = errKindsOf(all)
      if (kinds.length) {
        hr('Errors by type')
        const totalE = kinds.reduce((a, k) => a + k[1], 0)
        for (const [k, v] of kinds) L.push(`  ${padR(k, 18)} ${pad(v, 5)}  ${bar(v, totalE, 14)} ${pct(v, totalE)}%`)
        const topK = kinds.find(([k]) => k !== 'other' && k !== 'non-zero exit')
        if (topK && ERROR_TIPS[topK[0] as ErrorKind]) L.push(`  tip (${topK[0]}): ${ERROR_TIPS[topK[0] as ErrorKind]}`)
      }
      const sh = subShareOf(all)
      if (sh.sub > 0) {
        hr('Main vs subagents')
        L.push(`  main ${fmtN(sh.main)} · subagents ${fmtN(sh.sub)} tokens (${pct(sh.sub, sh.main + sh.sub)}%) · ${sh.subCalls} subagent tool calls`)
      }
    }
    hr('By project')
    const byP = byProject(all)
    const rows = [...byP.entries()].map(([k, v]) => [k, agg(v)] as const).sort((a, b) => b[1].activeMs - a[1].activeMs)
    const maxA = Math.max(1, ...rows.map(r => r[1].activeMs))
    L.push(`  project           sess  active              calls  err%     out  api-eq $`)
    for (const [k, a] of rows.slice(0, 12))
      L.push(`  ${padR(k, 16)} ${pad(a.n, 5)}  ${bar(a.activeMs, maxA, 10)} ${pad(fmtMs(a.activeMs), 7)} ${pad(a.calls, 6)} ${pad(pct(a.errors, a.calls) + '%', 5)} ${pad(fmtN(a.out), 7)} ${pad(usdText(a), 8)}`)

    const branches = byBranch(all)
    if (branches.length) {
      hr('Branches · newest first')
      L.push(`  branch                        active  prompts  api-eq $      lines  commits`)
      for (const b of branches.slice(0, 15)) {
        const name = sc.scope === 'all' ? `${b.project}/${b.branch}` : b.branch
        L.push(`  ${padR(name, 28)} ${pad(fmtMs(b.ms), 7)} ${pad(b.prompts, 8)} ${pad(b.usd ? '$' + b.usd.toFixed(2) : '—', 9)} ${pad(`+${b.added} −${b.removed}`, 10)} ${pad(b.commits, 8)}`)
      }
      if (branches.length > 15) L.push(`  …and ${branches.length - 15} more`)
    }

    hr('Tools across sessions')
    const tools = merge(all, x => x.tools)
    const errs = Object.fromEntries(merge(all, x => x.toolErr))
    const totalCalls = tools.reduce((a, t) => a + t[1], 0)
    const maxT = Math.max(1, ...tools.map(t => t[1]))
    L.push(`  tool                calls  share            err  err%`)
    for (const [k, v] of tools.slice(0, 15))
      L.push(`  ${padR(k, 18)} ${pad(v, 6)}  ${bar(v, maxT, 12)} ${pad(pct(v, totalCalls) + '%', 3)} ${pad(errs[k] ?? '·', 4)} ${pad(errs[k] ? pct(errs[k] ?? 0, v) + '%' : '', 5)}`)
    const worst = Object.entries(errs).filter(([k]) => k !== 'unknown').map(([k, e]) => [k, e, pct(e, tools.find(t => t[0] === k)?.[1] ?? 0)] as const).filter(r => r[1] >= 3).sort((a, b) => b[2] - a[2]).slice(0, 3)
    if (worst.length) L.push('', `  Most error-prone: ${worst.map(([k, e, p]) => `${k} ${p}% (${e})`).join(' · ')}`)

    const skills = skillRows(all)
    const skillsListed = skillList(all)
    if (skills.length || skillsListed) {
      hr('Skills (estimates)')
      L.push(`  skill                     uses  sessions  ≈tokens    ≈cost`)
      for (const r of skills.slice(0, 15))
        L.push(`  ${padR(r.name, 24)} ${pad(r.uses, 5)} ${pad(r.sessions, 9)} ${pad(r.tokens ? fmtN(r.tokens) : '?', 8)} ${pad(r.tokens ? fmtN(r.cost) : '?', 8)}`)
      if (skills.length > 15) L.push(`  …and ${skills.length - 15} more`)
      if (skillsListed) L.push(`  ${padR('List of skills, at most', 24)} ${pad('·', 5)} ${pad(skillsListed.sessions, 9)} ${pad(fmtN(skillsListed.tokens), 8)} ${pad(fmtN(skillsListed.cost), 8)}`)
      L.push(`  ${SKILLS_NOTE}`)
    }

    hr('Models')
    const models = merge(all, x => x.models)
    const totM = models.reduce((a, m) => a + m[1], 0)
    for (const [k, v] of models.slice(0, 6)) L.push(`  ${padR(k, 28)} ${pad(pct(v, totM) + '%', 4)}  ${bar(v, totM, 16)}`)

    hr('When you work')
    const hours = msPerHour(all)
    L.push(`  ${spark(hours)}`)
    L.push(`  0     6     12    18   23`)
    const wk = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    const wd = msPerWeekday(all)
    L.push(`  ${[1, 2, 3, 4, 5, 6, 0].map(i => `${wk[i]} ${spark([wd[i] ?? 0, Math.max(...wd)]).slice(0, 1)}`).join('  ')}`)

    const a = agg(all)
    hr('Habits')
    L.push(`  avg session      ${fmtMs(a.activeMs / all.length)} active · ${(a.prompts / all.length).toFixed(1)} prompts · ${(a.calls / all.length).toFixed(1)} calls`)
    L.push(`  calls per prompt ${(a.calls / Math.max(1, a.prompts)).toFixed(1)}   out tokens per prompt ${fmtN(a.out / Math.max(1, a.prompts))}`)
    const inT = all.reduce((s2, x) => s2 + x.inp + x.cr + x.cw, 0)
    L.push(`  cache hit        ${pct(all.reduce((s2, x) => s2 + x.cr, 0), inT)}%   subagent messages ${all.reduce((s2, x) => s2 + x.subMsgs, 0)}`)
    const longest = [...all].sort((p, q) => q.activeMs - p.activeMs)[0]
    if (longest) L.push(`  longest          ${fmtMs(longest.activeMs)} · ${projectName(longest)} · ${day(longest.start)}`)
  }
  const big = bigPending(h, currentId)
  const bigRead = h.sessions.filter(x => x.big && !x.tooBig && !x.failed).length
  const failed = h.sessions.filter(x => x.failed).length
  const onDisk = h.sessions.filter(x => !x.archived)
  const kept = h.sessions.length - onDisk.length
  const bigNote = big
    ? ` · ${big} large logs ${readingBig() ? 'being read in the background' : 'not read yet'}`
    : bigRead ? ` · ${bigRead} large logs read` : ''
  L.push('', `  logs: ${hidden ? '(hidden)' : h.dir || '?'} · scanned ${h.at ? ago(now, h.at) + ' ago' : 'never'}${bigNote}${failed ? ` · ${failed} unreadable` : ''}${h.total && h.total > onDisk.length ? ` · newest ${onDisk.length} of ${h.total}` : ''}${kept ? ` · ${kept} kept from deleted logs` : ''}`)
  if (!detailed) L.push('  /session-dash history — projects, tools, models, habits · /session-dash scan — re-read logs')
  L.push(sc.scope === 'project' ? '  showing this project only · /session-dash all — every project' : '  showing every project · /session-dash project — this project only')
  return L.join('\n')
}

export function textReport(
  s: Stats,
  usd: number | undefined,
  ctx: { percent?: number; tokens?: number; window: number },
  past: PastSession[],
  now: number,
  extra?: { notes: Insight[]; cur?: PerPrompt; norm?: Norm; limits?: LimitView[] },
): string {
  const c = summarize(s, usd)
  const main = s.turns.filter(t => !t.isSub)
  const subs = s.turns.filter(t => t.isSub)
  const L: string[] = []
  const hr = (title: string) => L.push('', `── ${title} ${'─'.repeat(Math.max(3, 44 - title.length))}`)

  const durs = main.map(t => t.ms).sort((x, y) => x - y)
  const median = durs.length ? durs[Math.floor(durs.length / 2)] ?? 0 : 0
  const longest = main.reduce<TurnRow | undefined>((m, t) => (!m || t.ms > m.ms ? t : m), undefined)
  const toolMs = s.tools.reduce((a, t) => a + t.ms, 0)
  const denied = s.tools.reduce((a, t) => a + t.denied, 0)
  const aborted = main.filter(t => t.reason === 'aborted').length
  const failed = main.filter(t => t.reason === 'error' || t.reason === 'refusal').length
  const span = s.startedAt ? now - s.startedAt : 0

  L.push(`SESSION DASHBOARD · started ${s.startedAt ? clock(s.startedAt) : '?'} (${s.startedAt ? ago(now, s.startedAt) : '?'} ago) · now ${clock(now)}`)

  if (extra?.limits?.length) {
    hr('Plan limits')
    for (const l of extra.limits)
      L.push(`  ${padR(l.label, 9)} ${bar(l.pct, 100, 20)} ${pad(Math.round(l.pct) + '%', 4)}${l.resetsInMs !== undefined ? `  resets in ${dur(l.resetsInMs)}` : ''}  ${paceText(l)}`)
  }
  // Only edit tools report lines, so no lines here doesn't mean no change.
  const made = [
    (s.linesAdded ?? 0) + (s.linesRemoved ?? 0) > 0 ? `+${s.linesAdded ?? 0} −${s.linesRemoved ?? 0} lines` : '',
    s.commits ? count(s.commits, 'commit') : '',
    s.prs ? count(s.prs, 'PR') : '',
  ].filter(Boolean)
  if (made.length) L.push('', `  Output: ${made.join(' · ')}`)
  if (extra && extra.notes.length) {
    hr('What stands out')
    for (const n of extra.notes) {
      L.push(`  ${levelIcon(n.level)} ${n.text}`)
      if (n.tip) L.push(`      ${n.tip}`)
    }
  }
  if (extra?.cur) {
    const { cur, norm } = extra
    hr(norm ? `Per prompt vs your norm (${norm.sessions} sessions${norm.isAllProjects ? ', all projects' : ''})` : 'Per prompt')
    const ln = (label: string, v: number, n: number | undefined, fmt: (x: number) => string) => {
      const c = n !== undefined ? compare(v, n) : undefined
      L.push(`  ${padR(label, 14)} ${pad(fmt(v), 8)}  ${c && c.arrow ? `${c.arrow} ${c.label}` : ''}${n !== undefined ? `  (usual ${fmt(n)})` : ''}`)
    }
    if (cur.usd !== undefined) ln('API-eq. cost', cur.usd, norm?.usd, v => '$' + v.toFixed(2))
    ln('model time', cur.activeMs, norm?.activeMs, fmtMs)
    ln('tool calls', cur.calls, norm?.calls, v => v.toFixed(1))
    ln('output tokens', cur.out, norm?.out, fmtN)
    if (cur.calls > 0) ln('errors', cur.errRate * 100, norm ? norm.errRate * 100 : undefined, v => Math.round(v) + '%')
  }
  hr('Overview')
  L.push(`  Prompts        ${pad(s.prompts, 8)}     Turns (main)   ${pad(main.length, 8)}`)
  L.push(`  Subagent runs  ${pad(subs.length, 8)}     Interrupted    ${pad(aborted, 8)}`)
  L.push(`  Failed turns   ${pad(failed, 8)}     Tool calls     ${pad(c.toolCalls, 8)}`)
  L.push(`  Tool errors    ${pad(`${c.errors} (${pct(c.errors, c.toolCalls)}%)`, 8)}     Denied         ${pad(denied, 8)}`)
  if (usd !== undefined) L.push(`  API-eq. cost   ${pad('$' + usd.toFixed(2), 8)}     per turn       ${pad(main.length ? '$' + (usd / main.length).toFixed(2) : '—', 8)}`)

  hr('Time')
  L.push(`  Wall clock     ${pad(fmtMs(span), 8)}     Model working  ${pad(fmtMs(c.activeMs), 8)} (${Math.min(100, pct(c.activeMs, span))}%)`)
  L.push(`  Avg turn       ${pad(fmtMs(main.length ? c.activeMs / main.length : 0), 8)}     Median turn    ${pad(fmtMs(median), 8)}`)
  L.push(`  In tools       ${pad(fmtMs(toolMs), 8)}     share of work  ${pad(pct(toolMs, c.activeMs) + '%', 8)}`)
  if (longest) L.push(`  Longest turn   ${pad(fmtMs(longest.ms), 8)}     "${padR(longest.prompt ?? '(continuation)', 30).trim()}"`)

  const sum = (f: (t: TurnRow) => number) => s.turns.reduce((a, t) => a + f(t), 0)
  const inp = sum(t => t.inp), cr = sum(t => t.cacheRead), cw = sum(t => t.cacheWrite), out = sum(t => t.out)
  const inTot = inp + cr + cw
  hr('Tokens & cache')
  L.push(`  Output         ${pad(fmtN(out), 8)}     avg/turn       ${pad(fmtN(main.length ? out / main.length : 0), 8)}`)
  L.push(`  Input total    ${pad(fmtN(inTot), 8)}`)
  L.push(`    cache read   ${pad(fmtN(cr), 8)}  ${bar(cr, inTot, 20)} ${pct(cr, inTot)}%`)
  L.push(`    cache write  ${pad(fmtN(cw), 8)}  ${bar(cw, inTot, 20)} ${pct(cw, inTot)}%`)
  L.push(`    uncached     ${pad(fmtN(inp), 8)}  ${bar(inp, inTot, 20)} ${pct(inp, inTot)}%`)
  if (ctx.percent !== undefined)
    L.push(`  Context        ${bar(ctx.percent, 100, 20)} ${ctx.percent}%  (${fmtN(ctx.tokens ?? 0)} / ${fmtN(ctx.window)})`)
  const models = [...new Set(s.turns.map(t => t.model).filter((m): m is string => !!m))]
  if (models.length) L.push(`  Models         ${models.join(', ')}`)

  if (main.length > 1) {
    const last = main.slice(-40)
    hr(`Trends (last ${last.length} turns)`)
    L.push(`  duration  ${spark(last.map(t => t.ms))}`)
    L.push(`  output    ${spark(last.map(t => t.out))}`)
    L.push(`  tools     ${spark(last.map(t => t.calls ?? 0))}`)
  }

  if (main.length) {
    hr('Turns (latest first)')
    L.push(`   #  time   dur      out  calls err  end      prompt`)
    const n0 = main.length
    main.slice(-12).reverse().forEach((t, i) => {
      L.push(
        `  ${pad(n0 - i, 2)}  ${t.at ? clock(t.at) : '  —  '} ${pad(fmtMs(t.ms), 6)} ${pad(fmtN(t.out), 7)} ${pad(t.calls ?? '—', 6)} ${pad(t.errs ?? '—', 3)}  ${padR(t.reason, 7)}  ${padR(t.prompt || '(continuation)', 34)}`,
      )
    })
  }

  const tools = [...s.tools].sort((a, b) => b.count - a.count)
  if (tools.length) {
    const max = Math.max(1, ...tools.map(t => t.count))
    hr('Tools')
    L.push(`  tool            calls  share                 avg     total   err  deny`)
    for (const t of tools.slice(0, 15))
      L.push(
        `  ${padR(t.name, 14)} ${pad(t.count, 6)}  ${bar(t.count, max, 14)} ${pad(pct(t.count, c.toolCalls) + '%', 4)} ${pad(fmtMs(t.ms / Math.max(1, t.count)), 7)} ${pad(fmtMs(t.ms), 8)} ${pad(t.errors || '·', 4)} ${pad(t.denied || '·', 5)}`,
      )
    const slow = [...s.recent].filter(r => r.status !== 'run').sort((x, y) => y.ms - x.ms).slice(0, 3)
    if (slow.length) L.push('', `  Slowest recent: ${slow.map(r => `${r.tool} ${fmtMs(r.ms)}`).join(' · ')}`)
  }

  if (s.recent.length) {
    hr('Recent calls')
    for (const r of s.recent.slice(-12).reverse()) {
      const mark = r.status === 'ok' ? '✓' : r.status === 'err' ? '✗' : r.status === 'deny' ? '⊘' : '…'
      L.push(`  ${mark} ${clock(r.at)}  ${padR(r.tool, 22)} ${pad(r.status === 'run' ? 'running' : fmtMs(r.ms), 8)}`)
    }
  }

  const ek = Object.entries(s.errKinds ?? {}).sort((a, b) => b[1] - a[1])
  if (ek.length) {
    hr('Errors by type')
    for (const [k, v] of ek) L.push(`  ${padR(k, 18)} ${pad(v, 4)}`)
  }
  if (subs.length) {
    hr('Subagents')
    L.push(`  runs ${subs.length} · time ${fmtMs(subs.reduce((a, t) => a + t.ms, 0))} · output ${fmtN(subs.reduce((a, t) => a + t.out, 0))}`)
  }

  return L.join('\n')
}
