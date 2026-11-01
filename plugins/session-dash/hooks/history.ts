// Reads Claude Code's own session logs (<config>/projects/<project>/<session>.jsonl)
// and turns each into a small summary, cached in the plugin's store by mtime.
import type { HistSession, HistScan } from '../types'
import { dayKey } from './days'
import { classifyError, isCommit, isPr, linesOf, resultText } from './signals'

export const SCAN_KEY = 'scan-9'
// Apart from the scan: SCAN_KEY changes with the parser, and what is here cannot be read again.
export const ARCHIVE_KEY = 'archive-1'
const MAX_ARCHIVE_CHARS = 1.5 * 1024 * 1024
const MAX_SESSIONS = 400
const MAX_BYTES = 4 * 1024 * 1024 - 1024 // $.fs.read refuses over 4 MiB
const IDLE_GAP = 5 * 60 * 1000 // a gap longer than this is not counted as work
export const RESCAN_MS = 10 * 60 * 1000

type Fs = {
  list: (p?: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }[]>
  read: (p: string) => Promise<string>
  exists: (p: string) => Promise<boolean>
}
type Host = {
  fs: Fs
  env: { get: (n: string) => Promise<string | undefined> }
  store: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> }
  clock: { now: () => Promise<number> }
}
type Spawner = {
  session: { id: () => Promise<string | undefined> }
  process: { spawn: (r: { argv: readonly string[] }) => AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }> }
}

const join = (...p: string[]) => p.join('/').replace(/[\\/]+/g, '/')

/** Scans under an earlier SCAN_KEY can never be read again. */
export async function dropOldScans($: { store: { keys: () => Promise<string[]>; delete: (k: string) => Promise<void> } }) {
  for (const k of await $.store.keys()) if (/^scan-\d+$/.test(k) && k !== SCAN_KEY) await $.store.delete(k)
}

/** Feeds a log too large for $.fs.read to a parser by streaming `cat`. */
async function streamLog($: Pick<Spawner, 'process'>, path: string, p: { feed: (text: string) => void }) {
  for await (const c of $.process.spawn({ argv: ['cat', path] })) if (c.stream === 'stdout') p.feed(c.text)
}

export async function projectsDir($: Host): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  for (const base of [cfg, home && join(home, '.claude')]) {
    if (!base) continue
    const dir = join(base, 'projects')
    if (await $.fs.exists(dir).catch(() => false)) return dir
  }
  return undefined
}

const top = (rec: Record<string, number>, n: number) =>
  Object.fromEntries(Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n))

type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean; text?: string; input?: Record<string, unknown>; content?: unknown }

type Base = Pick<HistSession, 'id' | 'project' | 'folder' | 'size' | 'mtime'>

// The engine's own messages open with a tag such as <task-notification> or
// <browser_instruction>. A paste is the person's message in a wrapper of its own.
const SERVICE_TAG = /^<(?!pasted_content)[a-z][a-z0-9]*[-_]/i
const PASTE_TAG = /<[\\/]?pasted_content\b[^>]*>/g

/** What the person wrote in a piece of a message; empty if the engine added it. */
const written = (text: string) => {
  const t = text.trim()
  return SERVICE_TAG.test(t) ? '' : t.replace(PASTE_TAG, '').trim()
}
const titleOf = (text: string) => text.replace(/\s+/g, ' ').slice(0, 140)

// Copies of API requests are half of a log's bytes, and only their time counts here.
// A line in any other shape falls through to JSON.parse.
const API_LINE = /^\{"type":"api-request(?:-shape)?","sessionId":"([^"]*)",.{0,200}?"timestamp":"([^"]+)"/
const API_BLOB = '{"type":"api-request-blob"'

/**
 * `owner` is the session whose lines count. A log can open with a full copy of
 * another session's, each copied line still under that session's id.
 */
export function createParser(base: Base, owner = base.id) {
  const s: HistSession = {
    ...base,
    start: 0, end: 0, activeMs: 0, prompts: 0, commands: 0, replies: 0, calls: 0, errors: 0,
    out: 0, inp: 0, cr: 0, cw: 0, models: {}, tools: {}, toolErr: {}, subMsgs: 0,
    linesAdded: 0, linesRemoved: 0, commits: 0, prs: 0, rejections: 0, interrupts: 0, compactions: 0,
    apiErrors: 0, retryMs: 0, errKinds: {}, subOut: 0, subIn: 0, subCalls: 0,
  }
  const seen = new Set<string>()
  const lines = new Set<string>()
  const toolOf = new Map<string, string>()
  const cmdOf = new Map<string, string>()
  let estAdded = 0
  let estRemoved = 0
  let hasLedgerLines = false
  let summaries = 0
  let boundaries = 0
  const times: number[] = []
  const days: Record<string, { ms: number; usd?: number }> = {}
  const dayStat = (t: number) => (days[dayKey(t)] ??= { ms: 0 })
  let lastTime = 0
  let usdSeen = 0
  let carry = ''

  const stamp = (v: unknown) => {
    if (typeof v !== 'string') return
    const t = Date.parse(v)
    if (Number.isNaN(t)) return
    times.push(t)
    lastTime = t
  }

  const line = (raw: string) => {
    if (!raw || raw.startsWith(API_BLOB)) return
    const api = API_LINE.exec(raw)
    if (api) {
      if (api[1] === owner) stamp(api[2])
      return
    }
    let o: Record<string, unknown>
    try {
      o = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof o.sessionId === 'string' && o.sessionId !== owner) {
      // A copied total is not this session's: only the rise above it is.
      if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number') usdSeen = o.totalCostUSD
      return
    }
    // A log can hold one line several times.
    if (typeof o.uuid === 'string') {
      if (lines.has(o.uuid)) return
      lines.add(o.uuid)
    }
    stamp(o.timestamp)
    if (!s.project && typeof o.cwd === 'string') s.project = o.cwd
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD') s.branch = o.gitBranch
    if (o.type === 'cost-state') {
      if (typeof o.totalCostUSD === 'number') {
        // The total only grows, and carries no time of its own: the rise goes to the day it was written.
        const rise = Math.max(0, o.totalCostUSD - usdSeen)
        usdSeen = o.totalCostUSD
        s.usd = (s.usd ?? 0) + rise
        const d = dayStat(lastTime || base.mtime)
        d.usd = (d.usd ?? 0) + rise
      }
      if (typeof o.totalLinesAdded === 'number') {
        hasLedgerLines = true
        s.linesAdded = o.totalLinesAdded
        s.linesRemoved = typeof o.totalLinesRemoved === 'number' ? o.totalLinesRemoved : 0
      }
      if (typeof o.totalAPIDuration === 'number' && typeof o.totalAPIDurationWithoutRetries === 'number')
        s.retryMs = Math.max(0, o.totalAPIDuration - o.totalAPIDurationWithoutRetries)
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') boundaries++
    if (o.isCompactSummary === true) {
      summaries++
      return
    }
    const side = o.isSidechain === true
    const msg = o.message as { id?: string; model?: string; content?: unknown; usage?: Record<string, number> } | undefined
    if (o.type === 'assistant' && msg) {
      if (o.isApiErrorMessage === true) s.apiErrors++
      const id = msg.id ?? String(o.uuid)
      if (!seen.has(id)) {
        seen.add(id)
        if (side) s.subMsgs++
        else s.replies++
        const u = msg.usage
        if (u) {
          s.out += u.output_tokens ?? 0
          s.inp += u.input_tokens ?? 0
          s.cr += u.cache_read_input_tokens ?? 0
          s.cw += u.cache_creation_input_tokens ?? 0
          if (side) {
            s.subOut += u.output_tokens ?? 0
            s.subIn += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
          }
        }
        if (msg.model && msg.model !== '<synthetic>') s.models[msg.model] = (s.models[msg.model] ?? 0) + 1
      }
      if (Array.isArray(msg.content))
        for (const b of msg.content as Block[])
          if (b.type === 'tool_use' && b.name) {
            s.calls++
            if (side) s.subCalls++
            s.tools[b.name] = (s.tools[b.name] ?? 0) + 1
            if (b.id) toolOf.set(b.id, b.name)
            const input = b.input ?? {}
            if (b.name === 'Bash' && b.id && typeof input.command === 'string') cmdOf.set(b.id, input.command)
            const l = linesOf(b.name, input)
            estAdded += l.added
            estRemoved += l.removed
          }
    } else if (o.type === 'user' && msg) {
      const c = msg.content
      if (typeof c === 'string') {
        if (c.startsWith('[Request interrupted by user')) s.interrupts++
        else if (!side && o.isMeta !== true) {
          if (c.startsWith('<command-name>')) s.commands++
          else if (written(c)) {
            s.prompts++
            if (!s.firstPrompt) s.firstPrompt = titleOf(written(c))
          }
        }
      } else if (Array.isArray(c)) {
        let typed = false
        for (const b of c as Block[]) {
          if (b.type === 'tool_result') {
            if (b.is_error) {
              s.errors++
              const n = (b.tool_use_id && toolOf.get(b.tool_use_id)) || 'unknown'
              s.toolErr[n] = (s.toolErr[n] ?? 0) + 1
              const kind = classifyError(resultText(b.content))
              s.errKinds[kind] = (s.errKinds[kind] ?? 0) + 1
              if (kind === 'rejected') s.rejections++
            } else {
              const cmd = b.tool_use_id ? cmdOf.get(b.tool_use_id) : undefined
              if (cmd && isCommit(cmd)) s.commits++
              if (cmd && isPr(cmd)) s.prs++
            }
          } else if (b.type === 'text' && (b.text ?? '').startsWith('[Request interrupted by user')) s.interrupts++
          else if (b.type === 'text' && written(b.text ?? '')) {
            typed = true
            if (!s.firstPrompt && !side && o.isMeta !== true) s.firstPrompt = titleOf(written(b.text ?? ''))
          }
        }
        if (typed && !side && o.isMeta !== true) s.prompts++
      }
    }
  }

  return {
    /** Takes the next piece of the log; a line cut between pieces is joined. */
    feed(text: string) {
      const parts = (carry + text).split('\n')
      carry = parts.pop() ?? ''
      for (const p of parts) line(p)
    },
    finish(): HistSession {
      line(carry)
      carry = ''
      times.sort((a, b) => a - b)
      s.start = times[0] ?? base.mtime
      s.end = times[times.length - 1] ?? base.mtime
      for (let i = 1; i < times.length; i++) {
        const gap = (times[i] ?? 0) - (times[i - 1] ?? 0)
        if (gap > 0 && gap <= IDLE_GAP) {
          s.activeMs += gap
          dayStat(times[i] ?? 0).ms += gap
        }
      }
      if (Object.keys(days).length) s.days = days
      s.tools = top(s.tools, 15)
      s.toolErr = top(s.toolErr, 10)
      s.compactions = Math.max(summaries, boundaries)
      if (!hasLedgerLines) {
        s.linesAdded = estAdded
        s.linesRemoved = estRemoved
        s.linesEstimated = true
      }
      return s
    },
  }
}

export function parseLog(text: string, base: Base, owner = base.id): HistSession {
  const p = createParser(base, owner)
  p.feed(text)
  return p.finish()
}

async function loadCache($: Host): Promise<HistScan> {
  const v = (await $.store.get(SCAN_KEY).catch(() => undefined)) as HistScan | undefined
  return v && Array.isArray(v.sessions) ? v : { at: 0, dir: '', sessions: [], skipped: 0 }
}

async function loadArchive($: Host): Promise<HistSession[]> {
  const v = await $.store.get(ARCHIVE_KEY).catch(() => undefined)
  return Array.isArray(v) ? (v as HistSession[]) : []
}

const withArchive = (h: HistScan, archive: HistSession[]): HistScan => {
  const live = new Set(h.sessions.map(x => x.id))
  return { ...h, sessions: [...h.sessions, ...archive.filter(x => !live.has(x.id))] }
}

/** The scan with the summaries of logs since deleted: what reports read. */
export async function loadScan($: Host): Promise<HistScan> {
  return withArchive(await loadCache($), await loadArchive($))
}

/** The newest that fit: the store holds 4 MiB in all. */
const fitArchive = (xs: HistSession[]) => {
  let size = 0
  return [...xs].sort((a, b) => b.end - a.end).filter(x => (size += JSON.stringify(x).length) <= MAX_ARCHIVE_CHARS)
}

/** Rescans the logs, reading only files that changed since the last scan. */
export async function scan($: Host & Spawner, opts: { force?: boolean } = {}): Promise<HistScan> {
  const prev = await loadCache($)
  const archive = await loadArchive($)
  const now = await $.clock.now()
  if (!opts.force && now - prev.at < RESCAN_MS && prev.sessions.length) return withArchive(prev, archive)
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
  const known = new Map(prev.sessions.map(s => [s.id, s]))
  const currentId = await $.session.id().catch(() => undefined)
  const out: HistSession[] = []
  let skipped = 0
  for (const f of files.slice(0, MAX_SESSIONS)) {
    const old = known.get(f.id)
    if (old && old.mtime === f.mtime && old.size === f.size) {
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
    out.push(await withSubagents($, parseLog(text, base), join(dir, f.folder, f.id, 'subagents')))
  }
  // A summary whose log has gone moves to the archive; one whose log came back leaves it.
  const listed = new Set(files.map(f => f.id))
  const gone = prev.sessions
    .filter(x => !listed.has(x.id) && !x.tooBig && (x.prompts > 0 || x.calls > 0 || x.replies > 0))
    .map(({ path: _path, failed: _failed, ...x }) => ({ ...x, archived: true }))
  const goneIds = new Set(gone.map(x => x.id))
  const kept = archive.filter(x => !listed.has(x.id) && !goneIds.has(x.id))
  let nextArchive = archive
  if (gone.length || kept.length !== archive.length) {
    const fitted = fitArchive([...gone, ...kept])
    if (await $.store.set(ARCHIVE_KEY, fitted).then(() => true, () => false)) nextArchive = fitted
    else out.push(...gone) // Not saved: stay in the scan until the next one tries again.
  }
  const result: HistScan = { at: now, dir, sessions: out, skipped, total: files.length }
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
async function withSubagents($: Host & Pick<Spawner, 'process'>, s: HistSession, dir: string): Promise<HistSession> {
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
  }
  return s
}

export const projectName = (s: HistSession) => {
  const p = s.project || s.folder
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export const projectKey = (s: HistSession) => (s.project || s.folder).replace(/[\\/]+$/, '')

const lastParts = (p: string, n: number) => p.split(/[\\/]/).filter(Boolean).slice(-n).join('/')

/** Sessions by project. Folders of one name stay apart, each named as far up its path as tells them apart. */
export function byProject(xs: HistSession[]): Map<string, HistSession[]> {
  const paths = new Map<string, HistSession[]>()
  for (const x of xs) paths.set(projectKey(x), [...(paths.get(projectKey(x)) ?? []), x])
  const label = (p: string) => {
    for (let n = 1; ; n++) {
      const t = lastParts(p, n)
      if (t === lastParts(p, n + 1) || [...paths.keys()].every(o => o === p || lastParts(o, n) !== t)) return t || p
    }
  }
  return new Map([...paths].map(([p, v]) => [label(p), v]))
}

let isReadingBig = false

const isPending = (x: HistSession, currentId: string | undefined) => !!x.path && !x.failed && x.id !== currentId

/**
 * Reads the logs too large for $.fs.read by streaming `cat`, one at a time,
 * saving each summary as it finishes. Runs in the background; one at a time.
 * This session's own log waits: reports leave it out and it keeps growing.
 */
export async function readBigLogs($: Host & Spawner, onProgress?: () => void): Promise<number> {
  if (isReadingBig) return 0
  isReadingBig = true
  let done = 0
  try {
    const currentId = await $.session.id().catch(() => undefined)
    for (;;) {
      const cur = await loadCache($)
      const next = cur.sessions.find(x => isPending(x, currentId))
      if (!next || !next.path) break
      let summary: HistSession
      try {
        const p = createParser({ id: next.id, project: '', folder: next.folder, size: next.size, mtime: next.mtime })
        await streamLog($, next.path, p)
        summary = await withSubagents($, { ...p.finish(), big: true, tooBig: false }, join(cur.dir, next.folder, next.id, 'subagents'))
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
    isReadingBig = false
  }
  return done
}

export const bigPending = (h: HistScan, currentId: string | undefined) => h.sessions.filter(x => isPending(x, currentId)).length
export const readingBig = () => isReadingBig
