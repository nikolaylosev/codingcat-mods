# Privacy policy for session-dash

session-dash runs only on your computer. It sends nothing to the plugin's author, to Anthropic or to anyone else, because it makes no network calls and doesn't call a model. The author receives no data from it and has no service that could hold your data.

## What the plugin reads

The plugin reads the session logs that Claude Code keeps in `~/.claude/projects`, or in `$CLAUDE_CONFIG_DIR/projects` when that variable is set. These logs hold your conversations with Claude, so they can contain personal data that you or Claude wrote, such as names and email addresses. The plugin also follows the current session through its hooks on prompts, turns and tool calls. It reads the `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` environment variables to find the logs, and it reads no credentials.

## What the plugin keeps

The plugin keeps a summary of each session in its own storage file on your computer, in `~/.claude/plugins/store/`. A summary holds counts, times, costs, the project path, git branch names, and tool and model names. A project path can contain your user name.

The summaries hold no prompt text unless you turn that on with `/dashboard prompts on`. That setting adds the first 140 characters of each session's first prompt, so that search can find them, and `/dashboard prompts off` removes that text again. The plugin also keeps the prompts of the current session's turns in that session's state for the Session tab.

## How the plugin uses the data

The plugin uses the data only to show the reports, the side pane and the band above the prompt. It doesn't build a profile of you, and it doesn't change how Claude behaves.

## How long the data stays

Summaries stay on your computer until you delete them. When Claude Code deletes an old log, the plugin keeps the summary of that log so that your history stays complete, up to about 1.5 MB of summaries, and the oldest leave first.

To delete the summaries, delete the files named `session-dash_*.json` in `~/.claude/plugins/store/`. Uninstalling the plugin might not remove them, so delete them yourself if you want them gone.

## Export files

The plugin writes files only when you run `/dashboard export` or press an export button. The files go to the folder you name, or to `session-dash-export` in the current project, and they don't include prompt text. You control these files, and anything you do with them is up to you.

## Contact

To ask a question about this policy or to report a problem, open an issue at https://github.com/nikolaylosev/codingcat-mods/issues.
