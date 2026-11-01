export type TurnRow = {
  id: string
  ms: number
  out: number
  inp: number
  cacheRead: number
  cacheWrite: number
  reason: string
  isSub: boolean
  tools: number
  at?: number
  calls?: number
  errs?: number
  model?: string
  prompt?: string
}
export type ToolStat = { name: string; count: number; errors: number; denied: number; ms: number }
export type CallRow = { id: string; tool: string; at: number; ms: number; status: 'run' | 'ok' | 'err' | 'deny' }
export type Stats = {
  startedAt: number
  turns: TurnRow[]
  tools: ToolStat[]
  recent: CallRow[]
  prompts: number
  pending?: { calls: number; errs: number; prompt: string }
  costAtStart?: number
  linesAdded?: number
  linesRemoved?: number
  commits?: number
  prs?: number
  errKinds?: Record<string, number>
  /** The context's fill after each main turn, in percent. */
  ctxTrail?: number[]
  /** The fill at which the context gets compacted, in percent. */
  ctxLimit?: number
}
export type LimitSample = { t: number; kind: string; pct: number; resetsAt?: string }
export type PastSession = {
  startedAt: number
  turns: number
  toolCalls: number
  errors: number
  outTokens: number
  activeMs: number
  cacheHit: number
  usd?: number
}

export type HistSession = {
  id: string
  project: string
  folder: string
  size: number
  mtime: number
  start: number
  end: number
  activeMs: number
  prompts: number
  commands: number
  replies: number
  calls: number
  errors: number
  out: number
  inp: number
  cr: number
  cw: number
  models: Record<string, number>
  tools: Record<string, number>
  toolErr: Record<string, number>
  subMsgs: number
  branch?: string
  firstPrompt?: string
  linesAdded: number
  linesRemoved: number
  linesEstimated?: boolean
  commits: number
  prs: number
  rejections: number
  interrupts: number
  compactions: number
  apiErrors: number
  retryMs: number
  errKinds: Record<string, number>
  subOut: number
  subIn: number
  subCalls: number
  usd?: number
  tooBig?: boolean
  big?: boolean
  path?: string
  failed?: boolean
  /** Active time and cost per local calendar day. */
  days?: Record<string, { ms: number; usd?: number }>
  /** Its log is gone: the last summary is all there is. */
  archived?: boolean
}
export type HistScan = {
  at: number
  dir: string
  sessions: HistSession[]
  skipped: number
  total?: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-dash': { stats: Shaped<Stats>; view: 'session' | 'history'; logsVer: number; scope: 'project' | 'all'; details: boolean; query: string }
  }
}
