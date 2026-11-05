import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { CallRow, HistScan, HistSession, LimitSample, Stats, ToolStat, TurnRow } from '../types'
import { bandView, OPEN_LABEL } from './band'
import { day, fmtMs, padR } from './format'
import { ARCHIVE_KEY, bigPending, createParser, fitArchive, isPending, join, MAX_BYTES, MAX_SESSIONS, parseLog, projectName, PROMPTS_KEY, readingBig, RESCAN_MS, SCAN_KEY, setReadingBig, withArchive, withoutPrompt } from './history'
import { currentOf, findings, normOf } from './insights'
import { KEEP_MS, limitView, MIN_GAP_MS, SAMPLES_KEY } from './limits'
import { exportFiles } from './export'
import { maskSession, maskStats, PRIVATE_KEY } from './privacy'
import { historyReport, textReport } from './report'
import { sessionView, tabsView } from './session-pane'
import { classifyError, denyKind, isCommit, isPr, linesOf } from './signals'
import { empty, inScope, PANE, searchSessions, TITLE } from './state'
import type { Scope } from './state'
import type { RenderEvent } from './chart-kit'
import { historyView } from './history-pane'

// Everything that reaches outside the plugin stays here: the plugin directory reads each
// call on $ from the file that declares the hooks, so the other files take plain data.
const stats = atom({ plugin: 'session-dash', key: 'stats' } as const, empty(), { shape: 'stats-1' })
const viewAtom = atom({ plugin: 'session-dash', key: 'view' } as const, 'session' as 'session' | 'history')
// Bumped whenever the log summaries change, so the pane redraws.
const logsVer = atom({ plugin: 'session-dash', key: 'logsVer' } as const, 0)
const queryAtom = atom({ plugin: 'session-dash', key: 'query' } as const, '')
const detailsAtom = atom({ plugin: 'session-dash', key: 'details' } as const, false)
// Which sessions the history counts: those of the session's project, or all.
const scopeAtom = atom({ plugin: 'session-dash', key: 'scope' } as const, 'project' as 'project' | 'all')

let logTimer: { cancel: () => void } | undefined

/** Whether summaries keep the start of each first prompt: only if the person turned it on. */
async function keepsPrompts($: EngineInterface) {
  return (await $.store.get(PROMPTS_KEY).catch(() => undefined)) === true
}

async function setKeepsPrompts($: EngineInterface, enabled: boolean) {
  await $.store.set(PROMPTS_KEY, enabled)
}

/** Scans under an earlier SCAN_KEY can never be read again. */
async function dropOldScans($: EngineInterface) {
  for (const k of await $.store.keys()) if (/^scan-\d+$/.test(k) && k !== SCAN_KEY) await $.store.delete(k)
}

/** Feeds a log too large for $.fs.read to a parser by streaming `cat`. */
async function streamLog($: EngineInterface, path: string, p: { feed: (text: string) => void }) {
  for await (const c of $.process.spawn({ argv: ['cat', path] })) if (c.stream === 'stdout') p.feed(c.text)
}

async function projectsDir($: EngineInterface): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  for (const base of [cfg, home && join(home, '.claude')]) {
    if (!base) continue
    const dir = join(base, 'projects')
    if (await $.fs.exists(dir).catch(() => false)) return dir
  }
  return undefined
}

async function loadCache($: EngineInterface): Promise<HistScan> {
  const v = (await $.store.get(SCAN_KEY).catch(() => undefined)) as HistScan | undefined
  return v && Array.isArray(v.sessions) ? v : { at: 0, dir: '', sessions: [], skipped: 0 }
}

async function loadArchive($: EngineInterface): Promise<HistSession[]> {
  const v = await $.store.get(ARCHIVE_KEY).catch(() => undefined)
  return Array.isArray(v) ? (v as HistSession[]) : []
}

/** The scan with the summaries of logs since deleted: what reports read. */
async function loadScan($: EngineInterface): Promise<HistScan> {
  return withArchive(await loadCache($), await loadArchive($))
}

/** Rescans the logs, reading only files that changed since the last scan. */
async function scan($: EngineInterface, opts: { force?: boolean } = {}): Promise<HistScan> {
  const prev = await loadCache($)
  const archive = await loadArchive($)
  const now = await $.clock.now()
  const keep = await keepsPrompts($)
  const shaped = (x: HistSession) => (keep ? x : withoutPrompt(x))
  if (!opts.force && now - prev.at < RESCAN_MS && prev.sessions.length && !!prev.withPrompts === keep) return withArchive(prev, archive)
  // Turned on: the logs hold what the summaries left out, so each is read again.
  const stale = keep && !prev.withPrompts
  const dir = await projectsDir($)
  if (!dir) return withArchive({ ...prev, at: now, error: 'no ~/.claude/projects folder found' }, archive)

  const files: { path: string; id: string; folder: string; size: number; mtime: number }[] = []
  for (const p of await $.fs.list(dir).catch(() => [])) {
    if (p.kind !== 'dir') continue
    for (const f of await $.fs.list(join(dir, p.name)).catch(() => []))
      if (f.kind === 'file' && f.name.endsWith('.jsonl'))
        files.push({ path: join(dir, p.name, f.name), id: f.name.slice(0, -6), folder: p.name, size: f.size, mtime: f.mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const known = new Map(prev.sessions.map(s => [s.id, shaped(s)]))
  const currentId = await $.session.id().catch(() => undefined)
  const out: HistSession[] = []
  let skipped = 0
  for (const f of files.slice(0, MAX_SESSIONS)) {
    const old = known.get(f.id)
    if (old && !stale && old.mtime === f.mtime && old.size === f.size) {
      out.push(old)
      if (old.tooBig) skipped++
      continue
    }
    // Reports leave this session out and its log keeps growing: the next session reads it.
    if (f.id === currentId && f.size <= MAX_BYTES) {
      if (old) out.push(old)
      continue
    }
    const base = { id: f.id, project: '', folder: f.folder, size: f.size, mtime: f.mtime }
    if (f.size > MAX_BYTES) {
      // A summary with a path is waiting for readBigLogs: the old numbers stay until then.
      if (old && !old.tooBig) {
        out.push({ ...old, size: f.size, mtime: f.mtime, big: true, path: f.path, failed: undefined })
        continue
      }
      skipped++
      out.push({ ...parseLog('', base), tooBig: true, big: true, path: f.path })
      continue
    }
    const text = await $.fs.read(f.path).catch(() => undefined)
    if (text === undefined) {
      skipped++
      continue
    }
    out.push(shaped(await withSubagents($, parseLog(text, base), join(dir, f.folder, f.id, 'subagents'))))
  }
  // A summary whose log has gone moves to the archive; one whose log came back leaves it.
  const listed = new Set(files.map(f => f.id))
  const gone = prev.sessions
    .filter(x => !listed.has(x.id) && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0))
    .map(({ path: _path, failed: _failed, ...x }) => ({ ...shaped(x), archived: true }))
  const goneIds = new Set(gone.map(x => x.id))
  const kept = archive.filter(x => !listed.has(x.id) && !goneIds.has(x.id)).map(shaped)
  let nextArchive = archive
  if (gone.length || kept.length !== archive.length || (!keep && archive.some(x => x.firstPrompt))) {
    const fitted = fitArchive([...gone, ...kept])
    if (await $.store.set(ARCHIVE_KEY, fitted).then(() => true, () => false)) nextArchive = fitted
    else out.push(...gone) // Not saved: stay in the scan until the next one tries again.
  }
  const result: HistScan = { at: now, dir, sessions: out, skipped, total: files.length, withPrompts: keep }
  await $.store.set(SCAN_KEY, result).catch(async () => {
    // The store holds 4 MiB in all: keep the newest half if it overflows.
    await $.store.set(SCAN_KEY, { ...result, sessions: out.slice(0, Math.floor(out.length / 2)) }).catch(() => undefined)
  })
  return withArchive(result, nextArchive)
}

/**
 * Adds the subagents' own logs (<session>/subagents/*.jsonl, where newer
 * Claude Code keeps them) to a session's tokens, as the subagent share.
 */
async function withSubagents($: EngineInterface, s: HistSession, dir: string): Promise<HistSession> {
  const files = await $.fs.list(dir).catch(() => [])
  for (const f of files) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
    const p = createParser({ id: f.name, project: '', folder: '', size: f.size, mtime: f.mtimeMs }, s.id)
    try {
      if (f.size > MAX_BYTES) await streamLog($, join(dir, f.name), p)
      else p.feed(await $.fs.read(join(dir, f.name)))
    } catch {
      continue
    }
    const a = p.finish()
    const inTot = a.inp + a.cr + a.cw
    s = {
      ...s,
      out: s.out + a.out, inp: s.inp + a.inp, cr: s.cr + a.cr, cw: s.cw + a.cw,
      subOut: s.subOut + a.out, subIn: s.subIn + inTot, subMsgs: s.subMsgs + a.subMsgs + a.replies, subCalls: s.subCalls + a.calls,
      errors: s.errors + a.errors, calls: s.calls + a.calls, rejections: s.rejections + a.rejections,
      errKinds: Object.entries(a.errKinds).reduce((r, [k, v]) => ({ ...r, [k]: (r[k] ?? 0) + v }), s.errKinds),
    }
    for (const [name, u] of Object.entries(a.skills ?? {})) {
      const o = s.skills?.[name]
      s = { ...s, skills: { ...s.skills, [name]: { uses: (o?.uses ?? 0) + u.uses, chars: Math.max(o?.chars ?? 0, u.chars), charCost: (o?.charCost ?? 0) + u.charCost } } }
    }
  }
  return s
}

/**
 * Reads the logs too large for $.fs.read by streaming `cat`, one at a time,
 * saving each summary as it finishes. Runs in the background; one at a time.
 * This session's own log waits: reports leave it out and it keeps growing.
 */
async function readBigLogs($: EngineInterface, onProgress?: () => void): Promise<number> {
  if (readingBig()) return 0
  setReadingBig(true)
  let done = 0
  try {
    const currentId = await $.session.id().catch(() => undefined)
    const keep = await keepsPrompts($)
    for (;;) {
      const cur = await loadCache($)
      const next = cur.sessions.find(x => isPending(x, currentId))
      if (!next || !next.path) break
      let summary: HistSession
      try {
        const p = createParser({ id: next.id, project: '', folder: next.folder, size: next.size, mtime: next.mtime })
        await streamLog($, next.path, p)
        const read = await withSubagents($, { ...p.finish(), big: true, tooBig: false }, join(cur.dir, next.folder, next.id, 'subagents'))
        summary = keep ? read : withoutPrompt(read)
      } catch {
        summary = { ...next, failed: true }
      }
      const fresh = await loadCache($)
      const sessions = fresh.sessions.map(x => (x.id === next.id && x.mtime === next.mtime ? summary : x))
      // Unsaved, this log would stay first in the queue: stop until the next refresh.
      const saved = await $.store.set(SCAN_KEY, { ...fresh, sessions, skipped: sessions.filter(x => x.tooBig).length }).then(() => true, () => false)
      if (!saved) break
      done++
      onProgress?.()
    }
  } finally {
    setReadingBig(false)
  }
  return done
}

async function loadSamples($: EngineInterface): Promise<LimitSample[]> {
  const v = await $.store.get(SAMPLES_KEY).catch(() => undefined)
  return Array.isArray(v) ? (v as LimitSample[]) : []
}

/** Adds the windows' current readings, at most one per window a minute. */
async function recordLimits($: EngineInterface): Promise<void> {
  const { rateLimits } = await $.session.usage()
  if (!rateLimits.length) return
  const now = await $.clock.now()
  const old = (await loadSamples($)).filter(x => now - x.t < KEEP_MS)
  const fresh: LimitSample[] = []
  for (const r of rateLimits) {
    const last = [...old].reverse().find(x => x.kind === r.kind)
    if (last && now - last.t < MIN_GAP_MS && last.pct === r.percentUsed) continue
    fresh.push({ t: now, kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt })
  }
  if (fresh.length) await $.store.set(SAMPLES_KEY, [...old, ...fresh].slice(-2000)).catch(() => undefined)
}

async function isPrivate($: EngineInterface) {
  return (await $.store.get(PRIVATE_KEY).catch(() => undefined)) === true
}

async function setPrivate($: EngineInterface, enabled: boolean) {
  await $.store.set(PRIVATE_KEY, enabled)
}

/** No known root (a host without one): every project. */
async function currentScope($: EngineInterface): Promise<Scope> {
  const root = await $.session.root().catch(() => '')
  return { scope: root ? await read($, scopeAtom) : 'all', root }
}

async function ensureOpen($: EngineInterface) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  return r.isPlaced
}

async function refreshLogs($: EngineInterface, force = false) {
  const bump = () => { update($, logsVer, v => v + 1).catch(() => undefined) }
  await scan($, { force }).catch(() => undefined)
  bump()
  await readBigLogs($, bump).catch(() => undefined)
  bump()
}

async function writeExport($: EngineInterface, xs: HistSession[], format: 'csv' | 'json', folder: string) {
  const files = exportFiles(xs, format, folder)
  for (const f of files) await $.fs.write(f.path, f.text)
  return files.map(f => f.path)
}

async function exportAll($: EngineInterface, format: 'csv' | 'json', chosen: string) {
  const id = await $.session.id().catch(() => undefined)
  const hidden = await isPrivate($)
  const root = await $.session.root().catch(() => '')
  const folder = chosen || `${root || '.'}/session-dash-export`
  const logs = await scan($).catch(() => loadScan($))
  const found = logs.sessions.filter(x => x.id !== id && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0))
  const xs = hidden ? found.map(maskSession) : found
  const paths = await writeExport($, xs, format, folder)
  // Privacy mode hides the project's path here too.
  const shown = hidden && root ? paths.map(p => p.replace(root, '<project>')) : paths
  return { count: xs.length, shown, big: bigPending(logs, id) }
}

async function exportFromPane($: EngineInterface, format: 'csv' | 'json') {
  const done = await exportAll($, format, '').catch(() => undefined)
  $.ui.toast(done ? `Exported ${done.count} sessions: ${(done.shown[0] ?? '').replace(/\/[^/]*$/, '')}` : 'The export failed')
}

async function drawBand($: EngineInterface, e: RenderEvent & { props: { bodyColumns: number } }, real: Stats) {
  const table = $.ui.resolve(e)
  const s = (await isPrivate($)) ? maskStats(real) : real
  const now = await $.clock.now()
  const usage = await $.session.usage().catch(() => undefined)
  const limits = usage ? limitView(usage.rateLimits, await loadSamples($), now) : []
  await read($, logsVer) // subscribes: redraw when the logs are re-read
  const logs = await loadScan($)
  const myId = await $.session.id().catch(() => undefined)
  const sc = await currentScope($)
  // Only the terminal has real cells: the apps draw a narrower font than they report, and wrap.
  const cols = e.surface === 'terminal' ? e.props.bodyColumns - OPEN_LABEL.length - 1 : Infinity
  const openPane = async () => {
    const r = await $.ui.open({ id: PANE, title: TITLE })
    if (!r.isPlaced) $.ui.toast(`The dashboard did not open: ${r.reason}`)
  }
  return bandView(table, { s, now, usage, limits, logs, myId, sc, cols, onOpen: () => { openPane() } })
}

async function drawPane($: EngineInterface, e: RenderEvent & { props?: { bodyColumns?: number }; viewport?: { columns: number } }) {
  const table = $.ui.resolve(e)
  const { Box } = table
  const view = await read($, viewAtom)
  await read($, logsVer) // subscribes: redraw when the logs are re-read
  const hidden = await isPrivate($)
  const tabs = tabsView(table, {
    view,
    hidden,
    setView: v => { update($, viewAtom, () => v) },
    togglePrivate: () => { setPrivate($, !hidden).then(() => update($, logsVer, v => v + 1)) },
  })
  const now = await $.clock.now()
  const logs = await loadScan($)
  const myId = await $.session.id().catch(() => undefined)
  const scope = await currentScope($)
  if (view === 'history') {
    const query = await read($, queryAtom)
    return (
      <Box flexDirection="column">
        {tabs}
        {historyView(table, {
          logs, now, myId, scope, hidden, query,
          cols: e.props?.bodyColumns ?? 60,
          surface: e.surface,
          setScope: v => { update($, scopeAtom, () => v) },
          setQuery: v => { update($, queryAtom, () => v) },
          rescan: () => { refreshLogs($, true) },
          exportAs: format => { exportFromPane($, format) },
        })}
      </Box>
    )
  }
  const real = await read($, stats)
  const showDetails = await read($, detailsAtom)
  const usage = await $.session.usage()
  const limits = limitView(usage.rateLimits, await loadSamples($), now)
  const resetStats = async () => {
    const t = await $.clock.now()
    const u = await $.session.usage()
    await update($, stats, () => ({ ...empty(), startedAt: t, costAtStart: u.cost?.usd }))
  }
  return sessionView(table, {
    tabs, showDetails, now, usage, limits, logs, myId, scope, hidden,
    s: hidden ? maskStats(real) : real,
    cols: e.props?.bodyColumns ?? e.viewport?.columns ?? 60,
    surface: e.surface,
    toggleDetails: () => { update($, detailsAtom, v => !v) },
    resetStats: () => { resetStats() },
  })
}

async function runDashboard($: EngineInterface, e: { args: string }) {
  const arg = e.args.trim().toLowerCase()
  const now = await $.clock.now()
  const id = await $.session.id().catch(() => undefined)
  const words = arg.split(/\s+/).filter(Boolean)
  const hidden = await isPrivate($)
  const everySession = (logs: HistScan) => {
    const xs = logs.sessions.filter(x => x.id !== id && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0))
    return hidden ? xs.map(maskSession) : xs
  }
  if (words[0] === 'private') {
    if (words[1] !== 'on' && words[1] !== 'off') return { text: `Usage: /session-dash private on|off  (now ${hidden ? 'on' : 'off'})` }
    await setPrivate($, words[1] === 'on')
    await update($, logsVer, v => v + 1)
    return { text: words[1] === 'on' ? 'Privacy mode on: projects, branches, MCP tools and prompts are hidden in the reports, the pane and exports.' : 'Privacy mode off.' }
  }
  if (words[0] === 'prompts') {
    if (words[1] !== 'on' && words[1] !== 'off') return { text: `Usage: /session-dash prompts on|off  (now ${(await keepsPrompts($)) ? 'on' : 'off'})` }
    await setKeepsPrompts($, words[1] === 'on')
    await scan($, { force: true }).catch(() => undefined)
    refreshLogs($)
    await update($, logsVer, v => v + 1)
    return { text: words[1] === 'on'
      ? 'Summaries now keep the first 140 characters of each session\'s first prompt, so search can find them. The logs are being read again.'
      : 'Summaries no longer hold prompt text, and what they held has been removed.' }
  }
  if (words[0] === 'export') {
    const format = words[1]
    if (format !== 'csv' && format !== 'json') return { text: 'Usage: /session-dash export csv|json [folder]' }
    const chosen = e.args.trim().split(/\s+/).slice(2).join(' ')
    const done = await exportAll($, format, chosen)
    return { text: [
      `Exported ${done.count} past sessions${hidden ? ' under aliases' : ''}. This session counts once it has ended.`,
      ...done.shown.map(p => `  ${p}`),
      ...(chosen ? [] : ['If this folder is inside a git repository, keep it out of your commits.']),
      ...(done.big ? [`${done.big} large logs are not read yet: export again in a minute or two.`] : []),
    ].join('\n') }
  }
  if (words[0] === 'search') {
    const q = e.args.trim().slice('search'.length).trim()
    await update($, queryAtom, () => q)
    await update($, viewAtom, () => 'history' as const)
    void $.ui.open({ id: PANE, title: TITLE })
    const logs = await scan($).catch(() => loadScan($))
    const every = everySession(logs)
    const found = searchSessions(every, q)
    const L = [`Search "${q}": ${found.length} of ${every.length} sessions, all projects`, '']
    for (const x of found.slice(0, 25)) {
      L.push(`  ${day(x.start)}  ${padR(projectName(x), 18)} ${x.branch ? '⎇ ' + x.branch : ''}`)
      if (x.firstPrompt) L.push(`      "${x.firstPrompt.slice(0, 100)}"`)
      L.push(`      ${x.prompts}p · ${x.calls} calls${x.errors ? ` · ${x.errors} err` : ''} · ${fmtMs(x.activeMs)}${x.linesAdded ? ` · +${x.linesAdded}` : ''}${x.commits ? ` · ${x.commits} commits` : ''}${x.usd !== undefined ? ` · $${x.usd.toFixed(2)} API-eq.` : ''}`)
    }
    if (found.length > 25) L.push(`  …and ${found.length - 25} more`)
    if (!found.length && !(await keepsPrompts($))) L.push('  Search reads project, branch and date. /session-dash prompts on adds the start of each first prompt.')
    return { text: q ? L.join('\n') : 'Usage: /session-dash search <words>  (project, branch or date like 10-31; prompt text after /session-dash prompts on)' }
  }
  if (words.includes('all')) await update($, scopeAtom, () => 'all' as const)
  if (words.includes('project')) await update($, scopeAtom, () => 'project' as const)
  const sc = await currentScope($)
  if (words.some(w => ['history', 'all', 'project', 'scan'].includes(w))) {
    const logs = await scan($, { force: words.includes('scan') })
    const big = bigPending(logs, id)
    if (big && !readingBig()) $.clock.after(10, () => { refreshLogs($) })
    await update($, viewAtom, () => 'history' as const)
    void $.ui.open({ id: PANE, title: TITLE })
    const note = big ? `\n\n  ${big} large logs are being read in the background: run /session-dash history again in a minute or two.` : ''
    return { text: historyReport(logs, id, now, true, sc, hidden).replace(/^\n/, '') + note }
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  const real = await read($, stats)
  const s = hidden ? maskStats(real) : real
  const usage = await $.session.usage()
  const logs = await scan($).catch(() => loadScan($))
  const usable = logs.sessions.filter(x => x.id !== id && !x.tooBig && (x.prompts > 0 || x.calls > 0))
  const norm = normOf(usable.filter(x => inScope(x, sc)), usable)
  const cur = currentOf(s, usage.cost?.usd)
  const limits = limitView(usage.rateLimits, await loadSamples($), now)
  const notes = findings({ s, cur, norm, contextPercent: usage.context.percent, limits })
  const report = textReport(s, usage.cost?.usd, usage.context, [], now, { notes, cur, norm, limits }) + '\n' + historyReport(logs, id, now, false, sc, hidden)
  return { text: opened.isPlaced ? `(also open in a side pane)\n\n${report}` : report }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const started = await $.session.usage().catch(() => undefined)
    const costNow = started?.cost?.usd
    await update($, stats, s => {
      const base = s.startedAt ? s : { ...empty(), startedAt: now }
      return base.costAtStart === undefined && costNow !== undefined ? { ...base, costAtStart: costNow } : base
    })
    await $.command.register({ name: 'session-dash', description: 'Session dashboard; "history", "project" / "all", "search <words>", "scan" to re-read logs, "export csv|json [folder]", "private on|off", "prompts on|off"' }).catch(() => undefined)
    ensureOpen($)
    recordLimits($).catch(() => undefined)
    // Read the logs, then the large ones by streaming, after the session is up. Always: the
    // session before this one may have only just ended, and a scan reads only the logs that changed.
    refreshLogs($, true)
    dropOldScans($).catch(() => undefined)
    // Other sessions keep writing. A scan does nothing if any session has made one lately.
    logTimer?.cancel()
    logTimer = $.clock.every(RESCAN_MS + 1000, () => {
      if (!readingBig()) refreshLogs($)
    })
    return next(e)
  })

  // The app often attaches after the session started: open the pane again then.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    ensureOpen($)
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'session-dash' }, ($, e) => runDashboard($, e)).catch(() => ({ text: 'session-dash: the dashboard failed to open.' }))

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
    recordLimits($).catch(() => undefined)
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined)
      await update($, stats, s => ({ ...s, pending: { calls: 0, errs: 0, prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 80) } }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // A limit can move with no change to anything the band reads, so it asks for a redraw itself.
  on('session.measure', ($, e, next) => {
    recordLimits($).catch(() => undefined)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    recordLimits($).catch(() => undefined)
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
