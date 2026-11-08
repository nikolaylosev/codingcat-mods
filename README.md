# codingcat-mods

[![session-dash](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fnikolaylosev%2Fcodingcat-mods%2Fmain%2Fplugins%2Fsession-dash%2F.claude-plugin%2Fplugin.json&query=%24.version&label=session-dash&prefix=v)](plugins/session-dash/README.md)
[![CI](https://github.com/nikolaylosev/codingcat-mods/actions/workflows/ci.yml/badge.svg)](https://github.com/nikolaylosev/codingcat-mods/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/nikolaylosev/codingcat-mods/blob/main/LICENSE)

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

## Check a mod

```
claude plugin validate plugins/session-dash
claude plugin test plugins/session-dash
```

## License

MIT. See [LICENSE](LICENSE).
