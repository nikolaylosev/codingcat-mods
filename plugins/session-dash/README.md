# session-dash

session-dash is a Claude Code plugin that shows how your sessions work. It adds a band above the prompt and a side pane with the current session, and it builds a history of your past sessions from the logs that Claude Code already keeps on your computer. Everything stays on your computer, because the plugin makes no network calls.

## What you see

The band above the prompt shows how full the context is and how close you are to your plan limits. It also shows the cost of this session, any errors and the tool that is running. Its second row gives your total for today, and a warning takes that row when a tool keeps failing or a similar problem needs attention. The Dashboard button opens the side pane.

The side pane has a Session tab and a History tab. The Session tab compares this session with your usual prompt and gives a tip for anything unusual. The History tab shows the following:

- Active time and cost per day, with a yearly activity heatmap and your working hours
- Totals per project, per git branch, per tool and per model
- Lines changed through the Edit and Write tools, commits and pull requests. Edits made through shell commands aren't in the line counts, because neither Claude Code's counter nor the plugin sees them.
- The skills you used, how often, how large each one is and an estimate of what it costs, along with the list of skills that each session's context holds
- Error types, rejected calls and interruptions

Every dollar amount is an API-equivalent cost, which is the figure that `/cost` shows, priced at API list prices. On a subscription plan it isn't what you pay, so use it to compare sessions. Times use the local time of your computer. A period counts only what happened on its days, so a session that ran over several days counts in each period for its share.

The skill figures are estimates, because the API reports tokens for a whole request and not for each skill. The plugin takes the size of a skill's text in characters and counts 4 characters as one token. It gives the cost in full-price input tokens, counting a cache write as 1.25 and each later request that reads the text as 0.1. The cost doesn't include the files that a skill leads Claude to read or the tools it leads Claude to run. A skill that puts no text in the log shows no size, and a session whose log was gone before this feature shows no skills.

## Examples

- Type `/session-dash` to see this session in detail, with a short history.
- Type `/session-dash history` to see all sessions, and `/session-dash project` or `/session-dash all` to choose between the current project and every project.
- Type `/session-dash search login fix` to find past sessions by project, branch or a date such as `10-31`.
- Type `/session-dash export csv` or press Export CSV in the History tab to write files that you can open in a spreadsheet. The command also takes a folder after `csv`.
- Type `/session-dash private on` before you share your screen, which replaces names with aliases such as `project-3f2a`.

`/session-dash scan` reads the logs again at once. Otherwise the plugin reads them when a session starts and every 10 minutes while a session is open.

## What the plugin reads, runs and stores

The plugin sends nothing off your computer. It has no network calls, and it doesn't call a model. Only two calls in its code pass data outside the plugin and its own storage, and neither one uses the network. The first call is `$.process.spawn`, which runs `cat` as described below, and the second call is `$.fs.write`, which writes the export files described below.

The plugin reads your session logs in `~/.claude/projects`, or in `$CLAUDE_CONFIG_DIR/projects` when that variable is set, and it never changes them. These logs hold your conversations with Claude. The plugin reads them only to work out the numbers above. To find the logs, it reads the `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` environment variables, and it reads no other variable and no credential. It also follows the current session through its hooks on prompts, turns and tool calls, which is how the Session tab stays current.

The plugin builds the path of the `projects` folder from those variables, and it opens only files that end in `.jsonl` below that folder. It doesn't open the file where Claude Code keeps your login. A log can hold a secret if someone pasted one into a conversation, and the plugin has no code that looks for secrets or treats them differently. The plugin sends nothing, so no part of it reads a credential in order to send it.

The plugin runs one outside program, which is `cat`, with the path of one session log as its only argument (`$.process.spawn({ argv: ['cat', path] })`). The path changes from log to log, so it can't be written as fixed text in the code, but it's always a `.jsonl` file below the `projects` folder. A plugin can't read a file over 4 MiB directly, so the plugin uses `cat` to read such a log and takes its output into its own parser, and the output goes nowhere else. This part works on macOS and Linux. The plugin doesn't run any other program.

The plugin keeps a summary of each session in its own storage on your computer. A summary holds counts, times, costs, the project path, git branch names, and tool, skill and model names. It holds no prompt text unless you run `/session-dash prompts on`, which adds the first 140 characters of each session's first prompt so that search can find them. `/session-dash prompts off` removes that text again. The plugin also keeps the prompts of the current session's turns in that session's state for the Session tab. When Claude Code deletes an old log, which by default happens after 30 days, the plugin keeps the summary of that log so that your history stays complete. It holds about 1.5 MB of summaries, and the oldest leave first. Uninstalling the plugin doesn't guarantee that this storage is removed.

The plugin writes files only when you run `/session-dash export` or press an export button, and it doesn't edit any build, start-up, settings or instruction file. It writes five files, which are `session-dash-sessions`, `session-dash-days`, `session-dash-projects`, `session-dash-branches` and `session-dash-models`, each ending in `.csv` or `.json`. They go to the folder you name, or to `session-dash-export` in the current project, so keep that folder out of your commits. The folder can't be written as fixed text in the code because you choose it, but the code sets the file names, so an export doesn't write to any other file name. Export files don't include prompt text.

Privacy mode is meant for showing a screen to someone. It hides names everywhere in the plugin, and it isn't encryption, because an alias can be guessed from a known name.

The address `http://www.w3.org/2000/svg` in the code is the standard name of the SVG format inside the charts, and the plugin doesn't connect to it.

[Privacy](PRIVACY.md) has the full privacy policy.

## Install

At the prompt of a terminal session, run the following command, answer `y` to add the marketplace, and pick the user scope so that the plugin loads in every session:

```
/plugin install session-dash --marketplace nikolaylosev/codingcat-mods
```

In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `nikolaylosev/codingcat-mods`, then Add plugin.

## Troubleshooting

If the history is empty or a number looks old, run `/session-dash scan`, because large logs are read in the background and appear as they finish. The running session joins the history only after it ends, so that its log is read once. If the side pane doesn't open by itself, press the Dashboard button or run `/session-dash`, because the pane opens by itself only in a wide window. A session's log gets its cost when the session ends, and logs of older Claude Code versions don't hold a cost, so those sessions show none. A plus sign after a total, as in `$4.30+`, means that some of its sessions have no cost yet, so the real total is at least that much.

To report a problem, open an issue at https://github.com/nikolaylosev/codingcat-mods/issues.

## Compatibility

Tested with Claude Code 2.1.310 and 2.1.316. Mods use an early access API, so a later release can change how the plugin behaves.

## License

MIT. See the [LICENSE](LICENSE) file.
