# Agent Package Resolution beta (internal) — Claude Code

Internal dogfooding branch **`feature/package-resolution`**. Not on the public marketplace yet.

> **Note:** The older branch `feature/package-guard` is deprecated for new installs; use `feature/package-resolution` instead. The old branch remains on the remote for now.

| Component | What it does |
|-----------|----------------|
| **package-resolution** hook | SessionStart policy + resolved Artifactory URLs (**governed types only**) |
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

## Configure (onboarding phases)

Work through these in order. After any `agents-conf.json` change, open a **new session** (or `/reload-plugins`) so the hook reloads.

### Phase 1 — JFrog CLI and credentials

Ensure `jf` works and your platform URL / token are set (`jf config add` or env vars).

Eager setup and resolved URLs both need **active** mode: a usable `jf` server (or platform env auth). If `jf` is missing/unconfigured, the hook injects a “routing NOT READY” notice instead and skips auto `jf setup`.

### Phase 2 — Enable + choose governed package types

Edit `~/.jfrog/agents-conf.json`. **`enabled: true` alone is not enough** — also declare **which package managers to govern** under `defaultGlobalRepos`. Only those types are routed through Artifactory; everything else stays out of scope.

Example — govern **npm and PyPI only**:

```json
{
  "packageResolution": {
    "enabled": true,
    "defaultGlobalRepos": {
      "npm": "npm-virtual",
      "pypi": "pypi-virtual"
    }
  }
}
```

Replace repo keys with ones that exist on your Artifactory. Optional: a project can add/override types via `.jfrog/local/package-resolution.json` (union with the global list).

### Phase 3 — Zero-touch PM setup (`enforceOnStartup`)

Advisory routing (Phase 2) tells Claude which URLs to use. **Durable** PM config (`~/.npmrc`, `pip.conf`, …) still needs `jf setup`. Enable eager setup so the hook runs that automatically on session start for the types you list:

```json
{
  "packageResolution": {
    "enabled": true,
    "defaultGlobalRepos": {
      "npm": "npm-virtual",
      "pypi": "pypi-virtual"
    },
    "enforceOnStartup": ["npm", "pypi"]
  }
}
```

Notes:

- Use a list of governed type names, or `"enforceOnStartup": true` for **all** governed types.
- Only **governed + resolved** types are eligible; others are ignored (logged).
- Runs in a **background** worker — session injection stays fast; check the injected note for “Zero-touch package-manager setup”.
- Idempotent via `~/.jfrog/skills-cache/package-setup.json` (skips fresh successes/failures until TTL / repo / server change).

**Verify Phase 3**

1. Start a **new session**.
2. Confirm the injected policy shows resolved URLs for your governed types and (when pending/done) a zero-touch status line.
3. Check durable config, e.g. `~/.npmrc` registry points at Artifactory after `npm` is in `enforceOnStartup`.
4. On failure or silence: `~/.jfrog/logs/agent-hooks.log` and `~/.jfrog/skills-cache/package-setup.json`.

### Phase 4 — Start using it

1. Confirm the plugin is active (`/plugin` or `claude plugin list`).
2. Phases 1–2 done (`enabled` + `defaultGlobalRepos`); Phase 3 optional but recommended for dogfooding eager setup.
3. Open a **new session** in a project with a package manifest or ask Claude to run package commands.

Full reference: [configure-agent-package-resolution](https://github.jfrog/jfrog-agent-hooks/blob/master/docs/configure-agent-package-resolution.md).

## Try it

### Example A — manual PM setup via skill (works with or without `enabled: true`)

Ask Claude:

> Configure my npm to use JFrog Artifactory

Uses **jfrog-setup-package-managers** (`jf setup` + workspace binding). Honors governed scope — won’t proactively onboard ungoverned PMs unless you ask.

### Example B — eager setup already configured the PM

With Phase 3 enabled for `npm`, start a **new session** (wait a few seconds if the note says “configuring in the background”), then ask:

> Run `npx cowsay hello`

**Expected:** indirect installs use durable Artifactory config from eager `jf setup` — you should **not** need to ask Claude to configure npm first.

### Example C — routing for a **governed** type (requires Phases 1–2)

With `npm` + `pypi` governed, start a **new session** and ask:

> Run `npm install express`

**Expected:** routes through Artifactory (`--registry <resolved npm URL>`). Policy says something like **"This policy governs only: npm, pypi"**.

Same for `pip install …` if `pypi` is governed.

### Example D — **ungoverned** types are left alone

With **no `docker`** in `defaultGlobalRepos`, ask:

> Run `docker pull alpine:latest`

**Expected:** no block/rewrite — docker is out of scope (may hit Docker Hub). To govern it, add `"docker": "<repo-key>"` (and optionally to `enforceOnStartup`), then start a new session.

### Example E — disabled

With `packageResolution.enabled: false`, governed routing is off; public registries are allowed unless you ask for JFrog explicitly.

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
