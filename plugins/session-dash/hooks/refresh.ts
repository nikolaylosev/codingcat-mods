// Re-reading the logs and telling the drawings.
import { atom, update } from 'claude-code'
import { readBigLogs, scan } from './history'

// The engine's scan reads an atom only from a const of the file that uses it.
// Bumped whenever the log summaries change, so the pane redraws.
const logsVer = atom({ plugin: 'session-dash', key: 'logsVer' } as const, 0)

export async function refreshLogs($: Parameters<typeof update>[0] & Parameters<typeof scan>[0] & Parameters<typeof readBigLogs>[0], force = false) {
  const bump = () => void update($, logsVer, v => v + 1).catch(() => undefined)
  await scan($, { force }).catch(() => undefined)
  bump()
  await readBigLogs($, bump).catch(() => undefined)
  bump()
}
