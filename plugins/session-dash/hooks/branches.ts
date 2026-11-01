// What each git branch cost: one branch is usually one task, over one session or several.
import type { HistSession } from '../types'
import { projectKey, projectName } from './history'

export type BranchRow = {
  project: string
  branch: string
  ms: number
  usd: number
  prompts: number
  commits: number
  added: number
  removed: number
  end: number
  sessions: number
}

/** The newest first. A branch of one name in two projects is two branches. */
export function byBranch(xs: HistSession[]): BranchRow[] {
  const rows = new Map<string, BranchRow>()
  for (const x of xs) {
    // A summary from before branches were counted has the one it ended on.
    const stats = x.branches ?? (x.branch ? { [x.branch]: { ms: x.activeMs, usd: x.usd, prompts: x.prompts, commits: x.commits, added: x.linesAdded, removed: x.linesRemoved, end: x.end } } : {})
    for (const [branch, d] of Object.entries(stats)) {
      const key = `${projectKey(x)}\n${branch}`
      const r = rows.get(key) ?? { project: projectName(x), branch, ms: 0, usd: 0, prompts: 0, commits: 0, added: 0, removed: 0, end: 0, sessions: 0 }
      rows.set(key, {
        ...r,
        ms: r.ms + (d.ms ?? 0), usd: r.usd + (d.usd ?? 0), prompts: r.prompts + (d.prompts ?? 0), commits: r.commits + (d.commits ?? 0),
        added: r.added + (d.added ?? 0), removed: r.removed + (d.removed ?? 0), end: Math.max(r.end, d.end), sessions: r.sessions + 1,
      })
    }
  }
  return [...rows.values()].sort((a, b) => b.end - a.end)
}
