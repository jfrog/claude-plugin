# Persisting environment variables

Read this when a Step 3 input needs to be exported so its `${VAR}` reference
resolves — i.e. any secret, or a non-secret you chose to keep out of the config
as `${VAR_NAME}`.

`${VAR}` references in `.mcp.json` / `~/.claude.json` resolve from the shell
that launched Claude Code, so the variable has to be exported in that shell and
persisted across relaunches. Detect the user's shell first, then give the
matching persistence command:

```bash
echo "$SHELL"
```

| Shell | Persist in | How |
|-------|-----------|-----|
| **zsh** (macOS default) | `~/.zshrc` | add `export VAR_NAME=<value>` |
| **bash** | `~/.bashrc` | add `export VAR_NAME=<value>` (macOS login shells read `~/.bash_profile`, which usually sources `~/.bashrc`) |
| **fish** | `~/.config/fish/config.fish` | add `set -gx VAR_NAME <value>` |
| **Windows** (PowerShell/CMD) | persistent user env | run `setx VAR_NAME "<value>"` |

- **Fallback:** if you cannot determine which file the shell sources, explicitly
  ask the user.
- **Security:** NEVER take secrets in the chat, echo them back, or write raw
  secret values into a config file. For secret values, instruct the user to add
  the line themselves (e.g. via `read -rs VAR_NAME && export VAR_NAME` for the
  current session) — you never see or type the value.
- After exporting, the user must **relaunch Claude Code** so `${VAR}`
  references resolve.
