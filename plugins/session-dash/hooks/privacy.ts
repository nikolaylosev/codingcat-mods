// Privacy mode: the names of client work leave the data before any report sees it.
import type { HistSession, Stats } from '../types'

export const PRIVATE_KEY = 'private'



/** The same name gets the same alias in every session, so charts still compare. */
const alias = (kind: string, name: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193)
  return `${kind}-${(h >>> 0).toString(36).padStart(7, '0').slice(-4)}`
}

const maskProject = (path: string) => alias('project', path.replace(/[\\/]+$/, ''))
// Built-in tools say nothing about the work; an MCP tool's name can name a client.
const maskTool = (name: string) => (name.startsWith('mcp__') ? alias('mcp', name) : name)
const maskKeys = <T>(rec: Record<string, T>, f: (k: string) => string) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [f(k), v]))

export function maskSession(x: HistSession): HistSession {
  const project = maskProject(x.project || x.folder)
  return {
    ...x,
    project,
    folder: project,
    branch: x.branch && alias('branch', x.branch),
    branches: x.branches && maskKeys(x.branches, k => (k === '(other)' ? k : alias('branch', k))),
    firstPrompt: undefined,
    path: undefined,
    tools: maskKeys(x.tools, maskTool),
    toolErr: maskKeys(x.toolErr, maskTool),
    // Anyone can name a skill, so its name can name a client.
    skills: x.skills && maskKeys(x.skills, k => alias('skill', k)),
  }
}

export function maskStats(s: Stats): Stats {
  return {
    ...s,
    turns: s.turns.map(t => ({ ...t, prompt: t.prompt === undefined ? undefined : '(hidden)' })),
    tools: s.tools.map(t => ({ ...t, name: maskTool(t.name) })),
    recent: s.recent.map(r => ({ ...r, tool: maskTool(r.tool) })),
    pending: s.pending && { ...s.pending, prompt: '(hidden)' },
  }
}

export const maskScope = <T extends { root: string }>(sc: T): T => (sc.root ? { ...sc, root: maskProject(sc.root) } : sc)
