# Agent Package Resolution beta (internal)

Branch **`feature/package-guard`** ships the full JFrog Claude plugin with **Agent Package Resolution** bundled alongside Agent Guard and all three skills:

| Component | What it does |
|-----------|----------------|
| **package-resolution** hook | SessionStart policy + resolved Artifactory URLs |
| **agent-guard** hook | MCP catalog governance (`inject-instructions.mjs`) |
| **jfrog** skill | Platform CLI / API workflows |
| **jfrog-package-safety-and-download** skill | Package safety checks |
| **jfrog-setup-package-managers** skill | `jf setup` PM binding (Agent Package Resolution companion) |

Not for public marketplace yet — share this branch with co-workers for dogfooding.

## One-command install (peers)

Requires the [Claude Code CLI](https://code.claude.com/docs) (`claude` on PATH).

```bash
git clone -b feature/package-guard --depth 1 https://github.com/jfrog/claude-plugin.git ~/.jfrog/claude-plugin-beta && \
  node ~/.jfrog/claude-plugin-beta/scripts/install-beta.mjs --repo-path ~/.jfrog/claude-plugin-beta
```

This registers the local marketplace (`.claude-plugin/marketplace.json`), runs `claude plugin install jfrog@jfrog-beta`, and sets `enabledPlugins` in `~/.claude/settings.json`.

Then restart Claude Code (or `/reload-plugins`) and open a **new session**.

**Quick dev (no install):** `claude --plugin-dir ~/.jfrog/claude-plugin-beta`

### Enable Agent Package Resolution

Agent Package Resolution is opt-in. After first session, edit `~/.jfrog/agents-conf.json`:

```json
{
  "packageResolution": {
    "enabled": true
  }
}
```

Or pre-deploy that file before the first session. See [configure-agent-package-resolution](https://github.jfrog/jfrog-agent-hooks/blob/master/docs/configure-agent-package-resolution.md) in `jfrog-agent-hooks`.

### Prerequisites

- `jf` CLI configured (`jf config add`) or `JFROG_URL` + `JFROG_ACCESS_TOKEN`
- Node.js ≥ 14 on `PATH` (hooks run via `node`)

## Uninstall beta

```bash
node ~/.jfrog/claude-plugin-beta/scripts/install-beta.mjs --uninstall
```

This runs `claude plugin uninstall jfrog@jfrog-beta`, `claude plugin marketplace remove jfrog-beta`, clears the plugin cache, and removes `enabledPlugins` entries from `~/.claude/settings.json`.

Then optionally delete the clone:

```bash
rm -rf ~/.jfrog/claude-plugin-beta
```

Re-install the public marketplace plugin with `/plugin install jfrog` if needed.

## Local development (contributors)

```bash
git checkout feature/package-guard
claude --plugin-dir .
# after edits:
/reload-plugins
```

### Re-sync from jfrog-agent-hooks

When `jfrog-agent-hooks` changes, refresh the vendored bundle:

```bash
JFROG_AGENT_HOOKS_PATH=/path/to/jfrog-agent-hooks node .github/scripts/sync-modules.mjs
```

Replaces the whole `modules/` tree per `paths` in `.github/scripts/sync-modules-vendor.json`.

## What install-beta.mjs does

**Install**

1. Runs `claude plugin marketplace add <repo-path>` (requires `.claude-plugin/marketplace.json`)
2. Runs `claude plugin install jfrog@jfrog-beta`
3. Sets `enabledPlugins["jfrog@jfrog-beta"] = true` in `~/.claude/settings.json`
4. Removes stale **manual** package-resolution hooks from `jfrog-agent-hooks/dev/install-local.mjs` (if present)
5. Backs up settings before any edit

**Uninstall (`--uninstall`)**

1. Runs `claude plugin uninstall jfrog@jfrog-beta -y`
2. Runs `claude plugin marketplace remove jfrog-beta`
3. Deletes `~/.claude/plugins/cache/jfrog-beta/` if present
4. Removes all `jfrog@…` keys from `enabledPlugins` (including legacy absolute-path keys)
5. Removes stale manual package-resolution hooks
6. Suggests `rm -rf <clone-path>` to delete the git clone (not run automatically)

Does **not** remove `~/.jfrog/agents-conf.json` (your config; keep or edit manually).
