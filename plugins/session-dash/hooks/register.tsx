import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { CallRow, ToolStat, TurnRow } from '../types'
import { drawBand } from './band'
import { day, fmtMs, padR } from './format'
import { bigPending, dropOldScans, loadScan, projectName, readingBig, RESCAN_MS, scan } from './history'
import { currentOf, findings, normOf } from './insights'
import { limitView, loadSamples, recordLimits } from './limits'
import { refreshLogs } from './refresh'
import { historyReport, textReport } from './report'
import { drawPane } from './session-pane'
import { classifyError, denyKind, isCommit, isPr, linesOf } from './signals'
import { currentScope, empty, ensureOpen, inScope, PANE, searchSessions, TITLE } from './state'

// The engine's scan reads an atom only from a const of the file that uses it.
const stats = atom({ plugin: 'session-dash', key: 'stats' } as const, empty(), { shape: 'stats-1' })
const viewAtom = atom({ plugin: 'session-dash', key: 'view' } as const, 'session' as 'session' | 'history')
const queryAtom = atom({ plugin: 'session-dash', key: 'query' } as const, '')
// Which sessions the history counts: those of the session's project, or all.
const scopeAtom = atom({ plugin: 'session-dash', key: 'scope' } as const, 'project' as 'project' | 'all')

let logTimer: { cancel: () => void } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const costNow = (await $.session.usage().catch(() => undefined))?.cost?.usd
    await update($, stats, s => {
      const base = s.startedAt ? s : { ...empty(), startedAt: now }
      return base.costAtStart === undefined && costNow !== undefined ? { ...base, costAtStart: costNow } : base
    })
    await $.command.register({ name: 'dash', description: 'Show a detailed dashboard of this session' })
    await $.command.register({ name: 'dashboard', description: 'Session dashboard; "history", "project" / "all", "search <words>", "scan" to re-read logs' })
    void ensureOpen($)
    void recordLimits($).catch(() => undefined)
    // Read the logs, then the large ones by streaming, after the session is up.
    void refreshLogs($)
    void dropOldScans($).catch(() => undefined)
    // Other sessions keep writing. A scan does nothing if any session has made one lately.
    logTimer?.cancel()
    logTimer = $.clock.every(RESCAN_MS + 1000, () => {
      if (!readingBig()) void refreshLogs($)
    })
    return next(e)
  })

  // The app often attaches after the session started: open the pane again then.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    void ensureOpen($)
    return r
  }).catch(($, e, next) => next(e))

  for (const command of ['dash', 'dashboard'] as const) {
    on('command.run', { command }, async ($, e) => {
      const arg = e.args.trim().toLowerCase()
      const now = await $.clock.now()
      const id = await $.session.id().catch(() => undefined)
      const words = arg.split(/\s+/).filter(Boolean)
      if (words[0] === 'search') {
        const q = e.args.trim().slice('search'.length).trim()
        await update($, queryAtom, () => q)
        await update($, viewAtom, () => 'history' as const)
        void $.ui.open({ id: PANE, title: TITLE })
        const logs = await scan($).catch(() => loadScan($))
        const every = logs.sessions.filter(x => x.id !== id && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0))
        const found = searchSessions(every, q)
        const L = [`Search "${q}": ${found.length} of ${every.length} sessions, all projects`, '']
        for (const x of found.slice(0, 25)) {
          L.push(`  ${day(x.start)}  ${padR(projectName(x), 18)} ${x.branch ? '⎇ ' + x.branch : ''}`)
          if (x.firstPrompt) L.push(`      "${x.firstPrompt.slice(0, 100)}"`)
          L.push(`      ${x.prompts}p · ${x.calls} calls${x.errors ? ` · ${x.errors} err` : ''} · ${fmtMs(x.activeMs)}${x.linesAdded ? ` · +${x.linesAdded}` : ''}${x.commits ? ` · ${x.commits} commits` : ''}${x.usd !== undefined ? ` · $${x.usd.toFixed(2)} API-eq.` : ''}`)
        }
        if (found.length > 25) L.push(`  …and ${found.length - 25} more`)
        return { text: q ? L.join('\n') : 'Usage: /dashboard search <words>  (project, branch, prompt text or date like 10-31)' }
      }
      if (words.includes('all')) await update($, scopeAtom, () => 'all' as const)
      if (words.includes('project')) await update($, scopeAtom, () => 'project' as const)
      const sc = await currentScope($)
      if (words.some(w => ['history', 'all', 'project', 'scan'].includes(w))) {
        const logs = await scan($, { force: words.includes('scan') })
        const big = bigPending(logs, id)
        if (big && !readingBig()) $.clock.after(10, () => void refreshLogs($))
        await update($, viewAtom, () => 'history' as const)
        void $.ui.open({ id: PANE, title: TITLE })
        const note = big ? `\n\n  ${big} large logs are being read in the background: run /dashboard history again in a minute or two.` : ''
        return { text: historyReport(logs, id, now, true, sc).replace(/^\n/, '') + note }
      }
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      const s = await read($, stats)
      const usage = await $.session.usage()
      const logs = await scan($).catch(() => loadScan($))
      const usable = logs.sessions.filter(x => x.id !== id && !x.tooBig && (x.prompts > 0 || x.calls > 0))
      const norm = normOf(usable.filter(x => inScope(x, sc)), usable)
      const cur = currentOf(s, usage.cost?.usd)
      const limits = limitView(usage.rateLimits, await loadSamples($), now)
      const notes = findings({ s, cur, norm, contextPercent: usage.context.percent, limits })
      const report = textReport(s, usage.cost?.usd, usage.context, [], now, { notes, cur, norm, limits }) + '\n' + historyReport(logs, id, now, false, sc)
      return { text: opened.isPlaced ? `(also open in a side pane)\n\n${report}` : report }
    }).catch(() => ({ text: 'session-dash: the dashboard failed to open.' }))
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, stats)
    if (e.props.hasSurvey || (s.turns.length === 0 && s.recent.length === 0)) return next(e)
    return drawBand($, e, s)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, stats, s => ({ ...s, prompts: s.prompts + 1 }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `${e.tool}-${Math.random()}`
    const t0 = await $.clock.now()
    await update($, stats, s => ({
      ...s,
      recent: [...s.recent, { id, tool: e.tool, at: t0, ms: 0, status: 'run' as const }].slice(-40),
    }))
    const ran = await next(e)
    const ms = (await $.clock.now()) - t0
    const status: CallRow['status'] = ran.deny !== undefined ? 'deny' : ran.isError ? 'err' : 'ok'
    const input = e as unknown as Record<string, unknown>
    const l = status === 'ok' ? linesOf(e.tool, input) : { added: 0, removed: 0 }
    const cmd = e.tool === 'Bash' && typeof input.command === 'string' ? input.command : ''
    const kind = status === 'err' ? classifyError(String(ran.text ?? '')) : status === 'deny' ? denyKind(String(ran.deny)) : undefined
    await update($, stats, s => {
      const tools: ToolStat[] = s.tools.some(t => t.name === e.tool)
        ? s.tools.map(t => (t.name === e.tool ? t : t))
        : [...s.tools, { name: e.tool, count: 0, errors: 0, denied: 0, ms: 0 }]
      return {
        ...s,
        tools: tools.map(t =>
          t.name === e.tool
            ? {
                ...t,
                count: t.count + 1,
                errors: t.errors + (status === 'err' ? 1 : 0),
                denied: t.denied + (status === 'deny' ? 1 : 0),
                ms: t.ms + ms,
              }
            : t,
        ),
        recent: s.recent.map(r => (r.id === id ? { ...r, ms, status } : r)),
        linesAdded: (s.linesAdded ?? 0) + l.added,
        linesRemoved: (s.linesRemoved ?? 0) + l.removed,
        commits: (s.commits ?? 0) + (status === 'ok' && cmd && isCommit(cmd) ? 1 : 0),
        prs: (s.prs ?? 0) + (status === 'ok' && cmd && isPr(cmd) ? 1 : 0),
        errKinds: kind ? { ...(s.errKinds ?? {}), [kind]: ((s.errKinds ?? {})[kind] ?? 0) + 1 } : s.errKinds,
        pending:
          e.agentId === undefined && s.pending
            ? { ...s.pending, calls: s.pending.calls + 1, errs: s.pending.errs + (status === 'err' ? 1 : 0) }
            : s.pending,
      }
    })
    void recordLimits($).catch(() => undefined)
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined)
      await update($, stats, s => ({ ...s, pending: { calls: 0, errs: 0, prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 80) } }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    void recordLimits($).catch(() => undefined)
    // Local estimate, no API call: where the context stands and where it gets compacted.
    const ctx = e.agentId === undefined ? (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context : undefined
    const compactAt = ctx?.breakdown?.autoCompactThreshold
    const u = e.usage
    const row: TurnRow = {
      id: e.turnId,
      ms: e.durationMs,
      out: u?.output_tokens ?? 0,
      inp: u?.input_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
      reason: e.reason,
      isSub: e.agentId !== undefined,
      tools: 0,
      at: await $.clock.now(),
      model: u?.model,
    }
    await update($, stats, s => {
      const p = !row.isSub ? s.pending : undefined
      const full: TurnRow = p ? { ...row, calls: p.calls, errs: p.errs, prompt: p.prompt } : row
      return {
        ...s,
        turns: [...s.turns, full].slice(-300),
        pending: row.isSub ? s.pending : undefined,
        ctxTrail: ctx?.percent !== undefined ? [...(s.ctxTrail ?? []), ctx.percent].slice(-12) : s.ctxTrail,
        ctxLimit: compactAt && ctx ? Math.min(100, (compactAt / ctx.window) * 100) : s.ctxLimit,
      }
    })
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, e))
}
