# Agent Package Resolution beta (internal) — Claude Code

Internal dogfooding branch **`feature/package-resolution`**. Not on the public marketplace yet.

> **Note:** The older branch `feature/package-guard` is deprecated for new installs; use `feature/package-resolution` instead. The old branch remains on the remote for now.

| Component | What it does |
|-----------|----------------|
| **package-resolution** hook | SessionStart policy + resolved Artifactory URLs |
| **agent-guard** hook | MCP catalog governance |
| **jfrog** skill | Platform CLI / API workflows |
| **jfrog-package-safety-and-download** skill | Package safety checks |
| **jfrog-setup-package-managers** skill | `jf setup` PM binding |

## Prerequisites

- [Claude Code CLI](https://code.claude.com/docs) (`claude` on PATH)
- **Node.js** ≥ 14 on `PATH` (hooks run via `node`)
- **`jf` CLI** configured (`jf config add`) or `JFROG_URL` + `JFROG_ACCESS_TOKEN`

## Install

```bash
git clone -b feature/package-resolution --depth 1 https://github.com/jfrog/claude-plugin.git ~/.jfrog/claude-plugin-beta && \
  node ~/.jfrog/claude-plugin-beta/scripts/install-beta.mjs --repo-path ~/.jfrog/claude-plugin-beta
```

This registers the local marketplace, installs `jfrog@jfrog-beta`, and enables it in `~/.claude/settings.json`.

Then restart Claude Code (or run `/reload-plugins`) and open a **new session**.

Verify: run `/plugin` or `claude plugin list` — you should see **jfrog@jfrog-beta**.

## Configure

### 1. JFrog CLI and credentials

Ensure `jf` works and your platform URL / token are set (`jf config add` or env vars).

### 2. Enable Agent Package Resolution (opt-in)

Edit `~/.jfrog/agents-conf.json`:

```json
{
  "packageResolution": {
    "enabled": true
  }
}
```

You can create this file before your first session. Details: [configure-agent-package-resolution](https://github.jfrog/jfrog-agent-hooks/blob/master/docs/configure-agent-package-resolution.md).

After changing this file, open a **new session** (or `/reload-plugins`) so the hook picks it up.

## Start using it

1. Confirm the plugin is active (`/plugin` or `claude plugin list`).
2. Set `packageResolution.enabled` if you want install routing (step above).
3. Open a **new session** in a project that has a package manifest or ask Claude to run package commands.

## Try it

### Example A — configure npm (works with or without `enabled: true`)

Ask Claude in natural language:

> Configure my npm to use JFrog Artifactory

This uses the **jfrog-setup-package-managers** skill (`jf setup npm`, workspace binding). It does **not** require `packageResolution.enabled`.

### Example B — package routing (requires `enabled: true`)

Enable package resolution, start a **new session**, then ask for example:

> Run `npm install express`

or

> Run `docker pull alpine:latest`

**Expected when enabled:** Claude routes installs through your Artifactory repos (from the session hook’s resolved URLs), not the public npm registry or Docker Hub. It should refuse or rewrite bare `docker pull alpine:latest` to your Artifactory docker repo if docker is bound.

**Expected when disabled:** Claude may install from public registries unless you ask it to use JFrog explicitly.

For docker, run Example A for docker first if you have no Artifactory docker binding yet.

## Update the plugin

Pull the latest beta branch and re-run the installer:

```bash
cd ~/.jfrog/claude-plugin-beta && \
  git pull origin feature/package-resolution && \
  node scripts/install-beta.mjs --repo-path ~/.jfrog/claude-plugin-beta
```

Then restart Claude Code (or `/reload-plugins`) and open a **new session**.

To get a completely fresh clone instead:

```bash
rm -rf ~/.jfrog/claude-plugin-beta && \
  git clone -b feature/package-resolution --depth 1 https://github.com/jfrog/claude-plugin.git ~/.jfrog/claude-plugin-beta && \
  node ~/.jfrog/claude-plugin-beta/scripts/install-beta.mjs --repo-path ~/.jfrog/claude-plugin-beta
```

## Uninstall

```bash
node ~/.jfrog/claude-plugin-beta/scripts/install-beta.mjs --uninstall
```

Optional — remove the clone:

```bash
rm -rf ~/.jfrog/claude-plugin-beta
```

Re-install the public marketplace plugin with `/plugin install jfrog` if needed.

Does **not** remove `~/.jfrog/agents-conf.json` — edit or delete that file manually if you want to turn off package resolution.
