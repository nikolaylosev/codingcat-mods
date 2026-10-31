# codingcat-mods

Claude Code mods by Coding Cat AI Lab.

## session-dash

A dashboard of how your Claude Code sessions work.

**This session, live:** turns, time spent by the model and in tools, output and input tokens, prompt cache hits, cost, context fill, tool calls with errors and denials, a table of turns and the latest calls.

**Every past session, from the local logs** (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`): totals for today, 7 and 30 days, active time per day, recent sessions, a breakdown by project, tools across sessions with error rates, models, the hours and weekdays you work, and habits such as calls per prompt. Logs are read only, never changed; summaries are cached and only changed logs are read again. Logs over 4 MiB are streamed with `cat` in the background after a session starts (macOS and Linux), one at a time, and appear in the history as they finish.

### Commands

- `/dashboard` (or `/dash`): this session in detail plus a short history; also opens the side pane where the window allows it.
- `/dashboard history`: the full history across all sessions and projects; also switches the pane to its History tab.
- `/dashboard scan`: read the logs again now (otherwise they are re-read at most every 10 minutes).

The side pane has two tabs, Session and History (hotkeys s and h); History shows totals, active time per day, projects, tools, models, working hours, habits and recent sessions, with a button to re-read the logs. A status line shows a one-line summary after every tool call and turn. The side pane opens by itself only in a wide window; `/dashboard` opens it at any width.

## Install

At the prompt of a terminal session:

```
/plugin install session-dash --marketplace nikolaylosev/codingcat-mods
```

From a shell:

```
claude plugin install session-dash --marketplace nikolaylosev/codingcat-mods
```

Answer `y` to add the marketplace, then pick the user scope so the mod loads in every session, VS Code included.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `nikolaylosev/codingcat-mods`, then Add plugin.

This repository is private: the install works only for people who can read it on GitHub and whose machine already has a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never asks for one.

Times are shown in the local time of the machine Claude Code runs on.
