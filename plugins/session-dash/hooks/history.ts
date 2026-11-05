// Reads Claude Code's own session logs (<config>/projects/<project>/<session>.jsonl)
// and turns each into a small summary, cached in the plugin's store by mtime.
import type { BranchStat, HistSession, HistScan } from '../types'
import { dayKey } from './days'
import { classifyError, isCommit, isPr, linesOf, resultText } from './signals'
import { loadCost } from './skills'

export const SCAN_KEY = 'scan-13'
// Apart from the scan: SCAN_KEY changes with the parser, and what is here cannot be read again.
export const ARCHIVE_KEY = 'archive-1'
const MAX_ARCHIVE_CHARS = 1.5 * 1024 * 1024
const MAX_BRANCHES = 100
const MAX_SKILLS = 15
export const MAX_SESSIONS = 400
export const MAX_BYTES = 4 * 1024 * 1024 - 1024 // $.fs.read refuses over 4 MiB
const IDLE_GAP = 5 * 60 * 1000 // a gap longer than this is not counted as work
export const RESCAN_MS = 10 * 60 * 1000


export const join = (...p: string[]) => p.join('/').replace(/[\\/]+/g, '/')

export const PROMPTS_KEY = 'search-prompts'



export const withoutPrompt = ({ firstPrompt: _prompt, ...x }: HistSession): HistSession => x




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
// The engine opens a loaded skill's text with this line, which ends in the skill's folder.
const SKILL_TEXT = 'Base directory for this skill:'
const skillFolder = (text: string) => (text.split('\n')[0] ?? '').split(/[\\/]/).pop()?.trim() ?? ''

/** The branches worth keeping, with the lines before the first named one folded into it. */
function branchesOf(raw: Record<string, BranchStat>, est: Record<string, { added: number; removed: number }>, first: string, hasLedger: boolean) {
  if (!first) return undefined
  const add = (a: number | undefined, b: number | undefined) => (a ?? 0) + (b ?? 0) || undefined
  const out: Record<string, BranchStat> = {}
  for (const [k, v] of Object.entries(raw)) {
    const name = k || first
    const e = hasLedger ? undefined : est[k]
    const o = out[name]
    out[name] = {
      ms: add(o?.ms, v.ms), usd: add(o?.usd, v.usd), prompts: add(o?.prompts, v.prompts), commits: add(o?.commits, v.commits),
      added: add(o?.added, e ? e.added : v.added), removed: add(o?.removed, e ? e.removed : v.removed),
      end: Math.max(o?.end ?? 0, v.end),
    }
  }
  const kept = Object.entries(out).filter(([, v]) => v.ms || v.usd || v.prompts || v.commits)
  kept.sort((a, b) => (b[1].ms ?? 0) - (a[1].ms ?? 0))
  if (kept.length > MAX_BRANCHES) {
    // The rest stay in the totals. JSON leaves out what is undefined.
    let rest: BranchStat = { end: 0 }
    for (const [, v] of kept.slice(MAX_BRANCHES))
      rest = {
        ms: add(rest.ms, v.ms), usd: add(rest.usd, v.usd), prompts: add(rest.prompts, v.prompts), commits: add(rest.commits, v.commits),
        added: add(rest.added, v.added), removed: add(rest.removed, v.removed), end: Math.max(rest.end, v.end),
      }
    return Object.fromEntries([...kept.slice(0, MAX_BRANCHES), ['(other)', rest]])
  }
  return kept.length ? Object.fromEntries(kept) : undefined
}

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
  const skillOf = new Map<string, string>()
  const skillUses: Record<string, number> = {}
  const skillLoads: { name: string; chars: number; at: number; side: boolean }[] = []
  let listChars = 0
  let listAt: number | undefined
  let estAdded = 0
  let estRemoved = 0
  let hasLedgerLines = false
  let summaries = 0
  let boundaries = 0
  const marks: { t: number; b: string }[] = []
  const perBranch: Record<string, BranchStat> = {}
  const estimated: Record<string, { added: number; removed: number }> = {}
  // Lines before the first that names a branch belong to that first one.
  let branchNow = ''
  let firstBranch = ''
  const here = (b = branchNow) => (perBranch[b] ??= { end: 0 })
  let addedSeen = 0
  let removedSeen = 0
  const days: Record<string, { ms: number; usd?: number }> = {}
  const dayStat = (t: number) => (days[dayKey(t)] ??= { ms: 0 })
  let lastTime = 0
  let usdSeen = 0
  let carry = ''

  const stamp = (v: unknown) => {
    if (typeof v !== 'string') return
    const t = Date.parse(v)
    if (Number.isNaN(t)) return
    marks.push({ t, b: branchNow })
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
      if (o.type === 'cost-state' && typeof o.totalLinesAdded === 'number') addedSeen = o.totalLinesAdded
      if (o.type === 'cost-state' && typeof o.totalLinesRemoved === 'number') removedSeen = o.totalLinesRemoved
      return
    }
    // A log can hold one line several times.
    if (typeof o.uuid === 'string') {
      if (lines.has(o.uuid)) return
      lines.add(o.uuid)
    }
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD') {
      s.branch = branchNow = o.gitBranch
      firstBranch ||= branchNow
    }
    stamp(o.timestamp)
    if (!s.project && typeof o.cwd === 'string') s.project = o.cwd
    if (o.type === 'cost-state') {
      if (typeof o.totalCostUSD === 'number') {
        // The total only grows, and carries no time of its own: the rise goes to the day it was written.
        const rise = Math.max(0, o.totalCostUSD - usdSeen)
        usdSeen = o.totalCostUSD
        s.usd = (s.usd ?? 0) + rise
        const d = dayStat(lastTime || base.mtime)
        d.usd = (d.usd ?? 0) + rise
        here().usd = (here().usd ?? 0) + rise
      }
      if (typeof o.totalLinesAdded === 'number') {
        hasLedgerLines = true
        s.linesAdded = o.totalLinesAdded
        s.linesRemoved = typeof o.totalLinesRemoved === 'number' ? o.totalLinesRemoved : 0
        here().added = (here().added ?? 0) + Math.max(0, s.linesAdded - addedSeen)
        here().removed = (here().removed ?? 0) + Math.max(0, s.linesRemoved - removedSeen)
        addedSeen = s.linesAdded
        removedSeen = s.linesRemoved
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
    if (o.type === 'attachment' && !side) {
      const a = o.attachment as { type?: string; content?: unknown; isInitial?: boolean } | undefined
      if (a?.type === 'skill_listing' && typeof a.content === 'string') {
        listChars = a.isInitial === true ? Math.max(listChars, a.content.length) : listChars + a.content.length
        listAt ??= s.replies
      }
    }
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
            if (b.name === 'Skill' && b.id && typeof input.skill === 'string') skillOf.set(b.id, input.skill)
            const l = linesOf(b.name, input)
            estAdded += l.added
            estRemoved += l.removed
            const est = (estimated[branchNow] ??= { added: 0, removed: 0 })
            est.added += l.added
            est.removed += l.removed
          }
    } else if (o.type === 'user' && msg) {
      const c = msg.content
      if (o.isMeta === true) {
        const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? (c as Block[]).map(b => (b.type === 'text' ? b.text ?? '' : '')) : []
        for (const text of texts) {
          if (!text.startsWith(SKILL_TEXT)) continue
          const called = typeof o.sourceToolUseID === 'string' ? skillOf.get(o.sourceToolUseID) : undefined
          const name = called ?? skillFolder(text)
          // A skill the person ran with its slash command has no tool call to count.
          if (!called && name) skillUses[name] = (skillUses[name] ?? 0) + 1
          if (name) skillLoads.push({ name, chars: text.length, at: side ? s.subMsgs : s.replies, side })
        }
      }
      if (typeof c === 'string') {
        if (c.startsWith('[Request interrupted by user')) s.interrupts++
        else if (!side && o.isMeta !== true) {
          if (c.startsWith('<command-name>')) s.commands++
          else if (written(c)) {
            s.prompts++
            here().prompts = (here().prompts ?? 0) + 1
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
              const skill = b.tool_use_id ? skillOf.get(b.tool_use_id) : undefined
              if (skill) skillUses[skill] = (skillUses[skill] ?? 0) + 1
              const cmd = b.tool_use_id ? cmdOf.get(b.tool_use_id) : undefined
              if (cmd && isCommit(cmd)) {
                s.commits++
                here().commits = (here().commits ?? 0) + 1
              }
              if (cmd && isPr(cmd)) s.prs++
            }
          } else if (b.type === 'text' && (b.text ?? '').startsWith('[Request interrupted by user')) s.interrupts++
          else if (b.type === 'text' && written(b.text ?? '')) {
            typed = true
            if (!s.firstPrompt && !side && o.isMeta !== true) s.firstPrompt = titleOf(written(b.text ?? ''))
          }
        }
        if (typed && !side && o.isMeta !== true) {
          s.prompts++
          here().prompts = (here().prompts ?? 0) + 1
        }
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
      marks.sort((a, b) => a.t - b.t)
      const hours = Array.from({ length: 24 }, () => 0)
      s.start = marks[0]?.t ?? base.mtime
      s.end = marks[marks.length - 1]?.t ?? base.mtime
      for (const m of marks) here(m.b).end = Math.max(here(m.b).end, m.t)
      for (let i = 1; i < marks.length; i++) {
        const t = marks[i]?.t ?? 0
        const gap = t - (marks[i - 1]?.t ?? 0)
        if (gap > 0 && gap <= IDLE_GAP) {
          s.activeMs += gap
          dayStat(t).ms += gap
          const inBranch = here(marks[i]?.b)
          inBranch.ms = (inBranch.ms ?? 0) + gap
          const h = new Date(t).getHours()
          hours[h] = (hours[h] ?? 0) + gap
        }
      }
      if (Object.keys(days).length) s.days = days
      if (s.activeMs) s.hours = hours
      s.branches = branchesOf(perBranch, estimated, firstBranch, hasLedgerLines)
      if (!s.branches) delete s.branches
      s.tools = top(s.tools, 15)
      s.toolErr = top(s.toolErr, 10)
      s.compactions = Math.max(summaries, boundaries)
      const skills: NonNullable<HistSession['skills']> = {}
      for (const name of Object.keys(top(skillUses, MAX_SKILLS))) {
        const loads = skillLoads.filter(l => l.name === name)
        skills[name] = {
          uses: skillUses[name] ?? 0,
          chars: Math.max(0, ...loads.map(l => l.chars)),
          charCost: Math.round(loads.reduce((t, l) => t + l.chars * loadCost((l.side ? s.subMsgs : s.replies) - l.at), 0)),
        }
      }
      if (Object.keys(skills).length) s.skills = skills
      if (listChars) {
        s.listChars = listChars
        s.listCost = Math.round(listChars * loadCost(s.replies - (listAt ?? 0)))
      }
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



export const withArchive = (h: HistScan, archive: HistSession[]): HistScan => {
  const live = new Set(h.sessions.map(x => x.id))
  return { ...h, sessions: [...h.sessions, ...archive.filter(x => !live.has(x.id))] }
}


/** The newest that fit: the store holds 4 MiB in all. */
export const fitArchive = (xs: HistSession[]) => {
  let size = 0
  return [...xs].sort((a, b) => b.end - a.end).filter(x => (size += JSON.stringify(x).length) <= MAX_ARCHIVE_CHARS)
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
export const setReadingBig = (on: boolean) => {
  isReadingBig = on
}

export const isPending = (x: HistSession, currentId: string | undefined) => !!x.path && !x.failed && x.id !== currentId


export const bigPending = (h: HistScan, currentId: string | undefined) => h.sessions.filter(x => isPending(x, currentId)).length
export const readingBig = () => isReadingBig
