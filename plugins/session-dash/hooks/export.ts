// Tables to keep counting in a spreadsheet.
import type { HistSession } from '../types'
import { byBranch } from './branches'
import { daysOf } from './days'
import { projectKey } from './history'

type Cell = string | number | undefined
export type Row = Record<string, Cell>

const minutes = (ms: number) => Math.round(ms / 6000) / 10
const money = (usd: number | undefined) => (usd === undefined ? undefined : Math.round(usd * 100) / 100)
const stamp = (t: number) => new Date(t).toISOString()

const totals = (x: HistSession): Row => ({
  prompts: x.prompts, tool_calls: x.calls, errors: x.errors,
  tokens_out: x.out, tokens_in: x.inp, tokens_cache_read: x.cr, tokens_cache_write: x.cw,
  api_eq_usd: money(x.usd), lines_added: x.linesAdded, lines_removed: x.linesRemoved,
  commits: x.commits, prs: x.prs, active_min: minutes(x.activeMs),
})

const addRows = (a: Row, b: Row): Row => {
  const r = { ...a }
  for (const [k, v] of Object.entries(b)) if (typeof v === 'number') r[k] = Math.round((Number(r[k] ?? 0) + v) * 100) / 100
  return r
}

export function exportTables(xs: HistSession[]): Record<string, Row[]> {
  const kinds = [...new Set(xs.flatMap(x => Object.keys(x.errKinds)))].sort()
  const sessions = [...xs].sort((a, b) => a.start - b.start).map(x => ({
    start: stamp(x.start), end: stamp(x.end), project: projectKey(x), branch: x.branch ?? '', ...totals(x),
    ...Object.fromEntries(kinds.map(k => [`errors_${k.replace(/\W+/g, '_')}`, x.errKinds[k] ?? 0])),
  }))

  const dayRows = new Map<string, Row>()
  for (const x of xs)
    for (const [date, d] of Object.entries(daysOf(x))) {
      const key = `${date}\n${projectKey(x)}`
      dayRows.set(key, addRows(dayRows.get(key) ?? { date, project: projectKey(x) }, { active_min: minutes(d.ms), api_eq_usd: money(d.usd) }))
    }

  const projectRows = new Map<string, Row>()
  for (const x of xs) {
    const k = projectKey(x)
    projectRows.set(k, addRows(projectRows.get(k) ?? { project: k, sessions: 0 }, { sessions: 1, ...totals(x) }))
  }

  const branches = byBranch(xs).map(b => ({
    project: b.project, branch: b.branch, sessions: b.sessions, prompts: b.prompts, api_eq_usd: money(b.usd),
    lines_added: b.added, lines_removed: b.removed, commits: b.commits, active_min: minutes(b.ms), last_active: stamp(b.end),
  }))

  const modelRows = new Map<string, Row>()
  for (const x of xs)
    for (const [model, messages] of Object.entries(x.models))
      modelRows.set(model, addRows(modelRows.get(model) ?? { model }, { messages, sessions: 1 }))

  return {
    sessions,
    days: [...dayRows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    projects: [...projectRows.values()],
    branches,
    models: [...modelRows.values()],
  }
}

// A spreadsheet runs a cell that opens like a formula, and a branch name can open any way it likes.
const cell = (v: Cell) => {
  if (v === undefined) return ''
  if (typeof v === 'number') return String(v)
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: Row[]): string {
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))]
  return [columns.join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\n') + '\n'
}

/** Writes one file per table and answers their paths. */
export async function writeExport($: { fs: { write: (p: string, text: string) => Promise<void> } }, xs: HistSession[], format: 'csv' | 'json', folder: string) {
  const paths: string[] = []
  for (const [name, rows] of Object.entries(exportTables(xs))) {
    const path = `${folder.replace(/[\\/]+$/, '')}/session-dash-${name}.${format}`
    await $.fs.write(path, format === 'csv' ? toCsv(rows) : JSON.stringify(rows, null, 2) + '\n')
    paths.push(path)
  }
  return paths
}
