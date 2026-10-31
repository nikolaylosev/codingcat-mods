// Reads Claude Code's own session logs (<config>/projects/<project>/<session>.jsonl)
// and turns each into a small summary, cached in the plugin's store by mtime.
import type { HistSession, HistScan } from '../types'

export const SCAN_KEY = 'scan-1'
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

type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean; text?: string }

export function parseLog(text: string, base: Omit<HistSession, 'start' | 'end' | 'activeMs' | 'prompts' | 'commands' | 'replies' | 'calls' | 'errors' | 'out' | 'inp' | 'cr' | 'cw' | 'models' | 'tools' | 'toolErr' | 'subMsgs'>): HistSession {
  const s: HistSession = {
    ...base,
    start: 0, end: 0, activeMs: 0, prompts: 0, commands: 0, replies: 0, calls: 0, errors: 0,
    out: 0, inp: 0, cr: 0, cw: 0, models: {}, tools: {}, toolErr: {}, subMsgs: 0,
  }
  const seen = new Set<string>()
  const toolOf = new Map<string, string>()
  const times: number[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp)
      if (!Number.isNaN(t)) times.push(t)
    }
    if (!s.project && typeof o.cwd === 'string') s.project = o.cwd
    if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number') s.usd = o.totalCostUSD
    const side = o.isSidechain === true
    const msg = o.message as { id?: string; model?: string; content?: unknown; usage?: Record<string, number> } | undefined
    if (o.type === 'assistant' && msg) {
      if (side) s.subMsgs++
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
        }
        if (msg.model && msg.model !== '<synthetic>') s.models[msg.model] = (s.models[msg.model] ?? 0) + 1
      }
      if (Array.isArray(msg.content))
        for (const b of msg.content as Block[])
          if (b.type === 'tool_use' && b.name) {
            s.calls++
            s.tools[b.name] = (s.tools[b.name] ?? 0) + 1
            if (b.id) toolOf.set(b.id, b.name)
          }
    } else if (o.type === 'user' && msg) {
      const c = msg.content
      if (typeof c === 'string') {
        if (!side && o.isMeta !== true) {
          if (c.startsWith('<command-name>')) s.commands++
          else if (!c.startsWith('<local-command') && !c.startsWith('<system-reminder>')) s.prompts++
        }
      } else if (Array.isArray(c)) {
        let typed = false
        for (const b of c as Block[]) {
          if (b.type === 'tool_result') {
            if (b.is_error) {
              s.errors++
              const n = (b.tool_use_id && toolOf.get(b.tool_use_id)) || 'unknown'
              s.toolErr[n] = (s.toolErr[n] ?? 0) + 1
            }
          } else if (b.type === 'text' && !(b.text ?? '').startsWith('<')) typed = true
        }
        if (typed && !side && o.isMeta !== true) s.prompts++
      }
    }
  }
  times.sort((a, b) => a - b)
  s.start = times[0] ?? base.mtime
  s.end = times[times.length - 1] ?? base.mtime
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] ?? 0) - (times[i - 1] ?? 0)
    if (gap > 0 && gap <= IDLE_GAP) s.activeMs += gap
  }
  s.tools = top(s.tools, 15)
  s.toolErr = top(s.toolErr, 10)
  return s
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
      continue
    }
    const base = { id: f.id, project: '', folder: f.folder, size: f.size, mtime: f.mtime }
    if (f.size > MAX_BYTES) {
      skipped++
      out.push({ ...parseLog('', base), tooBig: true })
      continue
    }
    const text = await $.fs.read(f.path).catch(() => undefined)
    if (text === undefined) {
      skipped++
      continue
    }
    out.push(parseLog(text, base))
  }
  const result: HistScan = { at: now, dir, sessions: out, skipped, total: files.length }
  await $.store.set(SCAN_KEY, result).catch(async () => {
    // The store holds 4 MiB in all: keep the newest half if it overflows.
    await $.store.set(SCAN_KEY, { ...result, sessions: out.slice(0, Math.floor(out.length / 2)) }).catch(() => undefined)
  })
  return result
}

export const projectName = (s: HistSession) => {
  const p = s.project || s.folder
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}
