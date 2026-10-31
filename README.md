# codingcat-mods

Claude Code mods by Coding Cat AI Lab.

## session-dash

A dashboard of how your Claude Code sessions work.

**This session, live:** what stands out, with a tip for each (context filling up, a tool that keeps failing, denied calls, interrupted turns, a cost, tool-call or cache figure far from your norm), and this session per prompt (cost, model time, tool calls, output tokens, errors) against your norm from past sessions of the same project. Turn charts, tools, recent calls and past sessions sit under Details.

**Every past session, from the local logs** (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`): totals for today, 7 and 30 days, active time per day, recent sessions, a breakdown by project, tools across sessions with error rates, models, the hours and weekdays you work, and habits such as calls per prompt. Logs are read only, never changed; summaries are cached and only changed logs are read again. Logs over 4 MiB are streamed with `cat` in the background after a session starts (macOS and Linux), one at a time, and appear in the history as they finish.

### Commands

- `/dashboard` (or `/dash`): this session in detail plus a short history; also opens the side pane where the window allows it.
- `/dashboard history`: the full history across all sessions and projects; also switches the pane to its History tab.
- `/dashboard project` / `/dashboard all`: count only the sessions of the current project (the default) or of every project; the choice is kept.
- `/dashboard scan`: read the logs again now (otherwise they are re-read at most every 10 minutes).

The side pane has two tabs, Session and History (hotkeys s and h); History shows totals, cost and efficiency per prompt (last 7 days against the 3 weeks before, dollars per day, the most expensive sessions), active time per day, projects, tools, models, working hours, habits and recent sessions, with buttons to switch between this project and all projects (hotkeys p and a) and to re-read the logs. A status line shows a one-line summary after every tool call and turn. The side pane opens by itself only in a wide window; `/dashboard` opens it at any width.

### About the dollar figures

Every dollar amount is an API-equivalent cost: Claude Code's own figure (the one `/cost` shows), priced at API list prices. On a subscription plan it is not what you pay; use it to compare sessions and prompts. For the current session it comes from the session's cost ledger; for past sessions from the last `cost-state` entry in each log (absent in logs of older Claude Code versions, which then show no cost). A session's whole cost counts on the day it started.

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
