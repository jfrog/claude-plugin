# Package Guard beta (internal)

Branch **`feature/package-guard`** ships the full JFrog Claude plugin with **Package Guard** bundled alongside Agent Guard and all three skills:

| Component | What it does |
|-----------|----------------|
| **package-guard** hook | SessionStart policy + resolved Artifactory URLs |
| **agent-guard** hook | MCP catalog governance (`inject-instructions.mjs`) |
| **jfrog** skill | Platform CLI / API workflows |
| **jfrog-package-safety-and-download** skill | Package safety checks |
| **jfrog-setup-package-managers** skill | `jf setup` PM binding (package-guard companion) |

Not for public marketplace yet — share this branch with co-workers for dogfooding.

## One-command install (peers)

```bash
git clone -b feature/package-guard --depth 1 https://github.com/jfrog/claude-plugin.git ~/.jfrog/claude-plugin-beta && \
  node ~/.jfrog/claude-plugin-beta/scripts/install-beta.mjs --repo-path ~/.jfrog/claude-plugin-beta
```

Then restart Claude Code (or `/reload-plugins`) and open a **new session**.

### Enable Package Guard

Package Guard is opt-in. After first session, edit `~/.jfrog/agents.json`:

```json
{
  "packageGuard": {
    "enabled": true
  }
}
```

Or pre-deploy that file before the first session. See [configure-package-guard](https://github.jfrog/jfrog-agent-hooks/blob/master/docs/configure-package-guard.md) in `jfrog-agent-hooks`.

### Prerequisites

- `jf` CLI configured (`jf config add`) or `JFROG_URL` + `JFROG_ACCESS_TOKEN`
- Node.js ≥ 14 on `PATH` (hooks run via `node`)

## Uninstall beta

```bash
node ~/.jfrog/claude-plugin-beta/scripts/install-beta.mjs --uninstall
```

Re-install marketplace plugin with `/plugin install jfrog` if needed.

## Local development (contributors)

```bash
git checkout feature/package-guard
claude --plugin-dir .
# after edits:
/reload-plugins
```

### Re-sync from jfrog-agent-hooks

When `jfrog-agent-hooks` changes, refresh vendored slices:

```bash
JFROG_AGENT_HOOKS_PATH=/path/to/jfrog-agent-hooks node .github/scripts/sync-agent-hooks.mjs
```

Pin recorded in `.github/scripts/sync-agent-hooks-vendor.json`.

## What install-beta.mjs does

1. Sets `enabledPlugins["jfrog@<absolute-path>"] = true` in `~/.claude/settings.json`
2. Removes stale **manual** package-guard hooks from `jfrog-agent-hooks/dev/install-local.mjs` (if present)
3. Backs up settings before any edit
4. Does **not** touch boost or other third-party hooks
