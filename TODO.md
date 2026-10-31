# TODO

Ideas for session-dash, not started yet.

## Privacy mode

A switch that hides project names, file paths, branch names and prompt text everywhere in the pane and the text reports (replaced by stable aliases such as `project-a`), so the dashboard can be shown or screenshotted for a team without exposing client work.

- A button on the pane and `/dashboard private on|off`; the choice is kept.
- Aliases stay the same across sessions, so charts still compare.

## Export to CSV or JSON

Files to keep counting in a spreadsheet: one row per session, per day, per project, and per model.

- `/dashboard export csv|json` writes them next to the project or to a chosen folder and names the paths.
- Columns: date, project, branch, prompts, tool calls, errors by type, tokens by kind, API-equivalent cost, lines added and removed, commits, PRs, active time.

## Git branches

Every log line carries `gitBranch`: time, cost and output per branch, i.e. per task.

- A "Branches" section in History: active time, prompts, API-equivalent cost, lines, commits per branch, newest first.
- Search and filter by branch.
