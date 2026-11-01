# codingcat-mods

Claude Code mods by Coding Cat AI Lab.

## session-dash

A dashboard of how your Claude Code sessions work.

**This session, live:** what stands out, with a tip for each (context filling up, a tool that keeps failing, denied calls, interrupted turns, a cost, tool-call or cache figure far from your norm), and this session per prompt (cost, model time, tool calls, output tokens, errors) against your norm from past sessions of the same project. Turn charts, tools, recent calls and past sessions sit under Details.

**Every past session, from the local logs** (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`): totals for today, 7 and 30 days, active time per day, recent sessions, a breakdown by project, tools across sessions with error rates, models, the hours and weekdays you work, and habits such as calls per prompt. Logs are read only, never changed; summaries are cached and only changed logs are read again. Logs over 4 MiB are streamed with `cat` in the background after a session starts (macOS and Linux), one at a time, and appear in the history as they finish. A large log that changed keeps its old numbers until the new summary is ready. The log of the running session is not read while it runs: reports leave it out, and the next session reads it.

### Commands

- `/dashboard` (or `/dash`): this session in detail plus a short history; also opens the side pane where the window allows it.
- `/dashboard history`: the full history across all sessions and projects; also switches the pane to its History tab.
- `/dashboard project` / `/dashboard all`: count only the sessions of the current project (the default) or of every project; the choice is kept.
- `/dashboard search <words>`: find past sessions of every project by project, branch, the first prompt or a date such as `10-31`; also fills the search field in the History tab.
- `/dashboard scan`: read the logs again now (otherwise they are re-read at most every 10 minutes).

The side pane has two tabs, Session and History (hotkeys s and h); History shows totals, cost and efficiency per prompt (last 7 days against the 3 weeks before, dollars per day, the most expensive sessions), active time per day, projects, tools, models, working hours, habits and recent sessions, with buttons to switch between this project and all projects (hotkeys p and a) and to re-read the logs. A band above the prompt shows the context with an estimate of the prompts left before it is compacted, plan limits with their reset time, API-equivalent cost, tool calls, errors, lines changed and the tool running now, updated after every tool call and turn. Its second row gives today's total across sessions (other sessions as of the last log scan; logs are scanned again every 10 minutes while a session is open) and what runs furthest above your usual prompt; when something other than a plan limit needs attention, that row names it with a tip instead. The Dashboard button on the band opens the side pane. The pane opens by itself only in a wide window; the button or `/dashboard` opens it at any width.

### Plan limits, output and trouble signals

- **Plan limits:** the 5-hour and 7-day windows of a subscription, how full each is, when it resets, and the pace: percent per hour over the recent readings and whether, at that pace, it fills before it resets. Readings are kept across sessions, so the pace is known soon after a session starts.
- **Output:** lines added and removed (from Claude Code's own count in the logs, or estimated from edits in older logs), commits (`git commit`) and pull requests (`gh pr create`) that succeeded, and efficiency: lines and commits per million tokens and lines per API-equivalent dollar, this week against the three before.
- **Trouble signals:** tool calls you rejected, interruptions, context compactions, API errors and the time lost to retries, per 10 prompts against the weeks before.
- **Errors by type:** command not found, missing file, permission, timeout, edit mismatch, failing tests, network, rejected, with a tip for the most common one.
- **Main loop vs subagents:** the share of tokens and tool calls spent in subagents, from their own logs as well.

### Your year and search

History opens with a search field (desktop, VS Code, terminal): every word must appear in a session's project, branch, first prompt or date, across all projects. Below the 30-day chart sits a year of activity as a GitHub-style heatmap, one cell per day by active time, with active days, the current and the longest streak and the busiest day.

### Charts

Where the surface draws SVG (VS Code, the desktop app, mobile) the pane shows a context gauge and donut charts: where tokens go (cache read, cache write, uncached input, output), tool calls by tool, and in History active time and API-equivalent cost by project, tool calls, tokens and replies by model. The terminal keeps text bars.

### About the dollar figures

Every dollar amount is an API-equivalent cost: Claude Code's own figure (the one `/cost` shows), priced at API list prices. On a subscription plan it is not what you pay; use it to compare sessions and prompts. For the current session it comes from the session's cost ledger; for past sessions from the last `cost-state` entry in each log (absent in logs of older Claude Code versions, which then show no cost). A session's whole cost counts on the day it started.

## Roadmap

See [TODO.md](TODO.md).

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
