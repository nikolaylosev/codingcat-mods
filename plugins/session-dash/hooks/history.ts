// Reads Claude Code's own session logs (<config>/projects/<project>/<session>.jsonl)
// and turns each into a small summary, cached in the plugin's store by mtime.
import type { HistSession, HistScan } from '../types'
import { classifyError, isCommit, isPr, linesOf, resultText } from './signals'

export const SCAN_KEY = 'scan-4'
const MAX_SESSIONS = 400
const MAX_BYTES = 4 * 1024 * 1024 - 1024 // $.fs.read refuses over 4 MiB
const IDLE_GAP = 5 * 60 * 1000 // a gap longer than this is not counted as work
const RESCAN_MS = 10 * 60 * 1000

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
  process: { spawn: (r: { argv: readonly string[] }) => AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }> }
}

const join = (...p: string[]) => p.join('/').replace(/[\\/]+/g, '/')

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

export function createParser(base: Base) {
  const s: HistSession = {
    ...base,
    start: 0, end: 0, activeMs: 0, prompts: 0, commands: 0, replies: 0, calls: 0, errors: 0,
    out: 0, inp: 0, cr: 0, cw: 0, models: {}, tools: {}, toolErr: {}, subMsgs: 0,
    linesAdded: 0, linesRemoved: 0, commits: 0, prs: 0, rejections: 0, interrupts: 0, compactions: 0,
    apiErrors: 0, retryMs: 0, errKinds: {}, subOut: 0, subIn: 0, subCalls: 0,
  }
  const seen = new Set<string>()
  const toolOf = new Map<string, string>()
  const cmdOf = new Map<string, string>()
  let estAdded = 0
  let estRemoved = 0
  let hasLedgerLines = false
  let summaries = 0
  let boundaries = 0
  const times: number[] = []
  let carry = ''

  const line = (raw: string) => {
    if (!raw) return
    let o: Record<string, unknown>
    try {
      o = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp)
      if (!Number.isNaN(t)) times.push(t)
    }
    if (!s.project && typeof o.cwd === 'string') s.project = o.cwd
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD') s.branch = o.gitBranch
    if (o.type === 'cost-state') {
      if (typeof o.totalCostUSD === 'number') s.usd = o.totalCostUSD
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
      if (side) s.subMsgs++
      if (o.isApiErrorMessage === true) s.apiErrors++
      const id = msg.id ?? String(o.uuid)
      if (!seen.has(id)) {
        seen.add(id)
        if (!side) s.replies++
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
          else if (!c.startsWith('<local-command') && !c.startsWith('<system-reminder>')) {
            s.prompts++
            if (!s.firstPrompt) s.firstPrompt = c.replace(/\s+/g, ' ').trim().slice(0, 140)
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
          else if (b.type === 'text' && !(b.text ?? '').startsWith('<')) {
            typed = true
            if (!s.firstPrompt && !side && o.isMeta !== true) s.firstPrompt = (b.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
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
        if (gap > 0 && gap <= IDLE_GAP) s.activeMs += gap
      }
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

export function parseLog(text: string, base: Base): HistSession {
  const p = createParser(base)
  p.feed(text)
  return p.finish()
}

export async function loadScan($: Host): Promise<HistScan> {
  const v = (await $.store.get(SCAN_KEY).catch(() => undefined)) as HistScan | undefined
  return v && Array.isArray(v.sessions) ? v : { at: 0, dir: '', sessions: [], skipped: 0 }
}

/** Rescans the logs, reading only files that changed since the last scan. */
export async function scan($: Host, opts: { force?: boolean } = {}): Promise<HistScan> {
  const prev = await loadScan($)
  const now = await $.clock.now()
  if (!opts.force && now - prev.at < RESCAN_MS && prev.sessions.length) return prev
  const dir = await projectsDir($)
  if (!dir) return { ...prev, at: now, error: 'no ~/.claude/projects folder found' }

  const files: { path: string; id: string; folder: string; size: number; mtime: number }[] = []
  for (const p of await $.fs.list(dir).catch(() => [])) {
    if (p.kind !== 'dir') continue
    for (const f of await $.fs.list(join(dir, p.name)).catch(() => []))
      if (f.kind === 'file' && f.name.endsWith('.jsonl'))
        files.push({ path: join(dir, p.name, f.name), id: f.name.slice(0, -6), folder: p.name, size: f.size, mtime: f.mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const known = new Map(prev.sessions.map(s => [s.id, s]))
  const out: HistSession[] = []
  let skipped = 0
  for (const f of files.slice(0, MAX_SESSIONS)) {
    const old = known.get(f.id)
    if (old && old.mtime === f.mtime && old.size === f.size) {
      out.push(old)
      if (old.tooBig) skipped++
      continue
    }
    const base = { id: f.id, project: '', folder: f.folder, size: f.size, mtime: f.mtime }
    if (f.size > MAX_BYTES) {
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
  const result: HistScan = { at: now, dir, sessions: out, skipped, total: files.length }
  await $.store.set(SCAN_KEY, result).catch(async () => {
    // The store holds 4 MiB in all: keep the newest half if it overflows.
    await $.store.set(SCAN_KEY, { ...result, sessions: out.slice(0, Math.floor(out.length / 2)) }).catch(() => undefined)
  })
  return result
}

/**
 * Adds the subagents' own logs (<session>/subagents/*.jsonl, where newer
 * Claude Code keeps them) to a session's tokens, as the subagent share.
 */
async function withSubagents($: Host, s: HistSession, dir: string): Promise<HistSession> {
  const files = await $.fs.list(dir).catch(() => [])
  for (const f of files) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.size > MAX_BYTES) continue
    const text = await $.fs.read(join(dir, f.name)).catch(() => undefined)
    if (!text) continue
    const a = parseLog(text, { id: f.name, project: '', folder: '', size: f.size, mtime: f.mtimeMs })
    const inTot = a.inp + a.cr + a.cw
    s = {
      ...s,
      out: s.out + a.out, inp: s.inp + a.inp, cr: s.cr + a.cr, cw: s.cw + a.cw,
      subOut: s.subOut + a.out, subIn: s.subIn + inTot, subMsgs: s.subMsgs + a.replies, subCalls: s.subCalls + a.calls,
      errors: s.errors + a.errors, calls: s.calls + a.calls,
    }
  }
  return s
}

export const projectName = (s: HistSession) => {
  const p = s.project || s.folder
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

let isReadingBig = false

/**
 * Reads the logs too large for $.fs.read by streaming `cat`, one at a time,
 * saving each summary as it finishes. Runs in the background; one at a time.
 */
export async function readBigLogs($: Host & Spawner, onProgress?: () => void): Promise<number> {
  if (isReadingBig) return 0
  isReadingBig = true
  let done = 0
  try {
    for (;;) {
      const cur = await loadScan($)
      const next = cur.sessions.find(x => x.tooBig && x.path && !x.failed)
      if (!next || !next.path) break
      let summary: HistSession
      try {
        const p = createParser(next)
        for await (const c of $.process.spawn({ argv: ['cat', next.path] })) if (c.stream === 'stdout') p.feed(c.text)
        summary = { ...p.finish(), big: true, tooBig: false }
        delete summary.path
      } catch {
        summary = { ...next, failed: true }
      }
      const fresh = await loadScan($)
      const sessions = fresh.sessions.map(x => (x.id === next.id && x.mtime === next.mtime ? summary : x))
      await $.store.set(SCAN_KEY, { ...fresh, sessions, skipped: sessions.filter(x => x.tooBig).length }).catch(() => undefined)
      done++
      onProgress?.()
    }
  } finally {
    isReadingBig = false
  }
  return done
}

export const bigPending = (h: HistScan) => h.sessions.filter(x => x.tooBig && !x.failed).length
export const readingBig = () => isReadingBig
