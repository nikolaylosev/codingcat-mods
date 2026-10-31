// Recognising what a tool's error text means, and what a command did.

export type ErrorKind =
  | 'rejected'
  | 'command not found'
  | 'missing file'
  | 'permission'
  | 'timeout'
  | 'edit mismatch'
  | 'tests failing'
  | 'network'
  | 'non-zero exit'
  | 'other'

const RULES: [ErrorKind, RegExp][] = [
  ['rejected', /doesn't want to proceed|user (?:rejected|denied|declined)|was rejected|rejected by the user/i],
  ['command not found', /command not found|not recognized as an internal|: not found\b|No module named|Cannot find module/i],
  ['edit mismatch', /String to replace not found|old_string|has not been read yet|File has been modified since|no changes to make/i],
  ['missing file', /No such file or directory|ENOENT|File does not exist|does not exist|not a directory/i],
  ['permission', /Permission denied|EACCES|EPERM|Operation not permitted|not allowed|denied by/i],
  ['timeout', /timed out|timeout|ETIMEDOUT/i],
  ['tests failing', /\b\d+ (?:failed|failing)\b|FAIL\b|AssertionError|Tests?:\s+\d+ failed|assert(?:ion)? failed/i],
  ['network', /ECONNREFUSED|ENOTFOUND|getaddrinfo|Could not resolve host|\b(?:403|404|500|502|503)\b.*(?:Forbidden|Not Found|Error)/i],
  ['non-zero exit', /Exit code \d+|exited with/i],
]

export function classifyError(text: string): ErrorKind {
  for (const [kind, re] of RULES) if (re.test(text)) return kind
  return 'other'
}

/** What a fix for each kind usually is, for the findings. */
export const ERROR_TIPS: Record<ErrorKind, string> = {
  rejected: 'You turned edits down: say what you want instead, or put the rule in CLAUDE.md',
  'command not found': 'A tool is missing: install it, or tell Claude in CLAUDE.md what to use instead',
  'missing file': 'Wrong paths: point to files explicitly or describe the layout in CLAUDE.md',
  permission: 'Blocked by permissions: allow the commands you trust in settings',
  timeout: 'Slow commands: raise the timeout or run them in the background',
  'edit mismatch': 'Edits miss their target: files change under Claude, ask it to re-read first',
  'tests failing': 'Tests keep failing: give the failing output and the expected behaviour',
  network: 'Network calls fail: check access, proxy or tokens',
  'non-zero exit': 'Commands exit with errors: look at the most frequent ones',
  other: '',
}

export const isCommit = (cmd: string) => /\bgit\b[^\n|;&]*\bcommit\b/.test(cmd) && !/--dry-run/.test(cmd)
export const isPr = (cmd: string) => /\bgh\s+pr\s+create\b/.test(cmd)

const lines = (s: unknown) => (typeof s === 'string' && s.length ? s.split('\n').length : 0)

/** Lines an edit tool's input adds and removes, as Claude Code counts them roughly. */
export function linesOf(tool: string, input: Record<string, unknown>): { added: number; removed: number } {
  if (tool === 'Write') return { added: lines(input.content), removed: 0 }
  if (tool === 'Edit') return { added: lines(input.new_string), removed: lines(input.old_string) }
  if (tool === 'MultiEdit' && Array.isArray(input.edits))
    return (input.edits as Record<string, unknown>[]).reduce<{ added: number; removed: number }>(
      (a, ed) => ({ added: a.added + lines(ed.new_string), removed: a.removed + lines(ed.old_string) }),
      { added: 0, removed: 0 },
    )
  if (tool === 'NotebookEdit') return { added: lines(input.new_source), removed: 0 }
  return { added: 0, removed: 0 }
}

/** The text of a tool_result's content, whichever shape it has. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n')
  return ''
}
