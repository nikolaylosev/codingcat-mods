# session-dash

session-dash is a Claude Code plugin that shows how your sessions work. It adds a band above the prompt and a side pane with the current session, and it builds a history of your past sessions from the logs that Claude Code already keeps on your computer. Everything stays on your computer, because the plugin makes no network calls.

## What you see

The band above the prompt shows how full the context is and how close you are to your plan limits. It also shows the cost of this session, any errors and the tool that is running. Its second row gives your total for today, and a warning takes that row when a tool keeps failing or a similar problem needs attention. The Dashboard button opens the side pane.

The side pane has a Session tab and a History tab. The Session tab compares this session with your usual prompt and gives a tip for anything unusual. The History tab shows the following:

- Active time and cost per day, with a yearly activity heatmap and your working hours
- Totals per project, per git branch, per tool and per model
- Lines changed, commits and pull requests
- Error types, rejected calls and interruptions

Every dollar amount is an API-equivalent cost, which is the figure that `/cost` shows, priced at API list prices. On a subscription plan it isn't what you pay, so use it to compare sessions. Times use the local time of your computer.

## Examples

- Type `/dashboard` to see this session in detail, with a short history.
- Type `/dashboard history` to see all sessions, and `/dashboard project` or `/dashboard all` to choose between the current project and every project.
- Type `/dashboard search login fix` to find past sessions by project, branch or a date such as `10-31`.
- Type `/dashboard export csv` to write files that you can open in a spreadsheet, or add a folder after `csv`.
- Type `/dashboard private on` before you share your screen, which replaces names with aliases such as `project-3f2a`.

`/dashboard scan` reads the logs again at once. Otherwise the plugin reads them when a session starts and every 10 minutes while a session is open.

## What the plugin reads, runs and stores

The plugin reads your session logs in `~/.claude/projects`, or in `$CLAUDE_CONFIG_DIR/projects` when that variable is set, and it never changes them. These logs hold your conversations with Claude. The plugin reads them only to work out the numbers above, and it doesn't send them anywhere.

The plugin runs one outside program, which is `cat`. It uses `cat` to read logs over 4 MiB, because a plugin can't read a file of that size directly, and this part works on macOS and Linux.

The plugin keeps a summary of each session in its own storage on your computer. A summary holds counts, times, costs, the project path, git branch names, and tool and model names. It holds no prompt text unless you run `/dashboard prompts on`, which adds the first 140 characters of each session's first prompt so that search can find them. `/dashboard prompts off` removes that text again. The plugin also keeps the prompts of the current session's turns in that session's state for the Session tab. When Claude Code deletes an old log, which by default happens after 30 days, the plugin keeps the summary of that log so that your history stays complete. It holds about 1.5 MB of summaries, and the oldest leave first. Uninstalling the plugin doesn't guarantee that this storage is removed.

The plugin writes files only when you run `/dashboard export`. The files go to the folder you name, or to `session-dash-export` in the current project, so keep that folder out of your commits. Export files don't include prompt text.

Privacy mode is meant for showing a screen to someone. It hides names everywhere in the plugin, and it isn't encryption, because an alias can be guessed from a known name.

## Install

At the prompt of a terminal session, run the following command, answer `y` to add the marketplace, and pick the user scope so that the plugin loads in every session:

```
/plugin install session-dash --marketplace nikolaylosev/codingcat-mods
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `nikolaylosev/codingcat-mods`, then Add plugin.

## Troubleshooting

If the history is empty or a number looks old, run `/dashboard scan`, because large logs are read in the background and appear as they finish. The running session joins the history only after it ends, so that its log is read once. If the side pane doesn't open by itself, press the Dashboard button or run `/dashboard`, because the pane opens by itself only in a wide window. Logs of older Claude Code versions don't hold a cost, so those sessions show none.

To report a problem, open an issue at https://github.com/nikolaylosev/codingcat-mods/issues.

## License

MIT. See the [LICENSE](LICENSE) file.
