# codingcat-mods

Claude Code mods by Coding Cat AI Lab.

| Mod | What it does |
|---|---|
| [session-dash](plugins/session-dash/README.md) | A dashboard of how your Claude Code sessions work: this session live, plus every past session read from the local logs |

## Install

At the prompt of a terminal session:

```
/plugin install session-dash --marketplace nikolaylosev/codingcat-mods
```

From a shell:

```
claude plugin install session-dash --marketplace nikolaylosev/codingcat-mods
```

Answer `y` to add the marketplace, then pick the user scope so that the mod loads in every session, VS Code included.

In the desktop app, where `/plugin` doesn't run, click + next to the prompt box, then Plugins, Add marketplace with `nikolaylosev/codingcat-mods`, then Add plugin.

This repository is private, so the install works only for people who can read it on GitHub and whose machine already has a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never asks for one.

## Check a mod

```
claude plugin validate plugins/session-dash
claude plugin test plugins/session-dash
```

## License

MIT. See [LICENSE](LICENSE).
