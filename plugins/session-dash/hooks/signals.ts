// Recognising what a tool's error text means, and what a command did.

export type ErrorKind =
  | 'rejected'
  | 'denied'
  | 'command not found'
  | 'missing file'
  | 'permission'
  | 'timeout'
  | 'edit mismatch'
  | 'tests failing'
  | 'network'
  | 'script error'
  | 'shell error'
  | 'git error'
  | 'no output'
  | 'non-zero exit'
  | 'other'

const RULES: [ErrorKind, RegExp][] = [
  ['rejected', /doesn't want to proceed|user (?:rejected|denied|declined)|was rejected|rejected by the user|denied by the user/i],
  // A hook, a rule, auto mode or the engine's own check stopped the call. Its text can quote the command.
  ['denied', /^Permission for this|^The server-side auto mode|^<tool_use_error>Blocked:|denied by/],
  ['command not found', /command not found|not recognized as an internal|: not found\b|No module named|Cannot find module/i],
  ['edit mismatch', /String to replace not found|old_string|has not been read yet|File has been modified since|no changes to make/i],
  ['missing file', /No such file or directory|ENOENT|File does not exist|does not exist|not a directory/i],
  ['permission', /Permission denied|EACCES|EPERM|Operation not permitted|not allowed/i],
  ['timeout', /timed out|timeout|ETIMEDOUT/i],
  ['tests failing', /\b\d+ (?:failed|failing)\b|FAIL\b|AssertionError|Tests?:\s+\d+ failed|assert(?:ion)? failed/i],
  ['network', /ECONNREFUSED|ENOTFOUND|getaddrinfo|Could not resolve host|\b(?:403|404|500|502|503)\b.*(?:Forbidden|Not Found|Error)/i],
  ['script error', /\b(?:Syntax|Type|Reference|Range|Name|Key|Value|Index|Attribute|Import|Runtime)Error\b|Traceback|Unexpected token|Unhandled|\bat .+:\d+:\d+|\berror TS\d+/],
  // The shell itself complains, before or instead of running the command.
  ['shell error', /^(?:\(eval\)|zsh|bash|sh)(?::\s?(?:line )?\d+)?:\s|syntax error near|unexpected EOF|bad substitution|no matches found|bad math expression/m],
  ['git error', /^fatal: |^error: (?:pathspec|failed to push|Your local changes|src refspec)|^ ! \[(?:remote )?rejected\]|GraphQL:|pull request create failed/m],
  ['no output', /^Exit code \d+\s*$/],
  ['non-zero exit', /Exit code \d+|exited with/i],
]

export function classifyError(text: string): ErrorKind {
  for (const [kind, re] of RULES) if (re.test(text)) return kind
  return 'other'
}

/** A refused call is the person's own refusal only if its text says so. */
export const denyKind = (text: string): ErrorKind => (classifyError(text) === 'rejected' ? 'rejected' : 'denied')

/** What a fix for each kind usually is, for the findings. */
export const ERROR_TIPS: Record<ErrorKind, string> = {
  rejected: 'You turned edits down: say what you want instead, or put the rule in CLAUDE.md',
  denied: 'A hook, a rule or auto mode stopped them: if they were fine, allow them in settings',
  'command not found': 'A tool is missing: install it, or tell Claude in CLAUDE.md what to use instead',
  'missing file': 'Wrong paths: point to files explicitly or describe the layout in CLAUDE.md',
  permission: 'Blocked by permissions: allow the commands you trust in settings',
  timeout: 'Slow commands: raise the timeout or run them in the background',
  'edit mismatch': 'Edits miss their target: files change under Claude, ask it to re-read first',
  'tests failing': 'Tests keep failing: give the failing output and the expected behaviour',
  network: 'Network calls fail: check access, proxy or tokens',
  'script error': 'Scripts throw exceptions: ask Claude to try them on a small input first',
  'shell error': 'The shell misread commands: ask Claude to quote wildcards and to put long commands in a script',
  'git error': 'Git or gh refused commands: check the branch, the remote and your login',
  'no output': '',
  'non-zero exit': 'Commands exit with errors: look at the most frequent ones',
  other: '',
}

// `git`, then its own options, then the subcommand, at the start of a command in a chain.
const GIT_COMMIT = /^\s*\(?\s*(?:(?:then|do|else|if|while|!|\{|time|sudo)\s+)*(?:\w+=\S*\s+)*git\s+(?:-[cC]\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*commit(?:\s|$)/
export const isCommit = (cmd: string) => cmd.split(/&&|\|\||[;|\n]/).some(c => GIT_COMMIT.test(c) && !/--dry-run/.test(c))
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
