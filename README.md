# JFrog Claude Plugin

![JFrog](assets/logo.svg)

JFrog integration for [Claude Code](https://claude.com/product/claude-code): artifact management, security scanning, and supply-chain best practices.

This repository **is** the plugin: manifest at [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json), skills under [`skills/`](skills/).

## What's included

| Component | Path | Description |
| --- | --- | --- |
| **Manifest** | [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) | Plugin id `jfrog`, version, metadata. |
| **Skills** | [`skills/`](skills/) | `skills/<name>/SKILL.md`, invoked as `/jfrog:<name>` when the plugin is loaded. |
| **MCP Gateway hook** | [`hooks/hooks.json`](hooks/hooks.json), [`scripts/inject-instructions.mjs`](scripts/inject-instructions.mjs), [`templates/jfrog-mcp-management.md`](templates/jfrog-mcp-management.md) | A `SessionStart` hook that injects MCP-management instructions into Claude's context so MCP servers can only be added/removed/listed through the **JFrog MCP Gateway** (`@jfrog/mcp-gateway`). |

Skills are vendored from [jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills); the pinned **release and commit** are in [`skills/VENDOR.md`](skills/VENDOR.md).

## JFrog MCP Gateway integration

When the plugin is enabled, every Claude Code session starts with the rules in [`templates/jfrog-mcp-management.md`](templates/jfrog-mcp-management.md) injected into the model's context (via the [`additionalContext`](https://docs.anthropic.com/en/docs/claude-code/hooks#sessionstart) `SessionStart` hook output). **No instructions file is written to your repo** — the rules live only in the plugin and reach the model directly through the hook.

The rules tell Claude to:

- Add MCP servers only through `npx @jfrog/mcp-gateway --inspect / --login / --list-available`, never via direct `npx`/`pip`/`docker` or hand-rolled catalog API calls.
- Resolve project / server ID from `.claude/settings.json` (`allowedMcpServers`), then existing `.mcp.json` / `~/.claude.json`, then `~/.jfrog/jfrog-cli.conf.v6`.
- Write the entry to **`.mcp.json` (project scope) by default** — creating the file if it doesn't exist — so the entry stays alongside the project and the team can share it via git. Only fall back to `~/.claude.json` (user scope) when you ask for it explicitly. Either way, secrets stay out of the file via `${ENV_VAR}` expansion (Claude Code has no native interactive secret prompt).
- Run the gateway's `--login` automatically for OAuth-only remote MCPs.

After a new MCP entry is written, you must (1) **export every `${VAR}` referenced by the entry** in the shell that will launch Claude Code so the gateway has them at server-start time (an unset variable shows as `[Contains warnings]` in `/mcp` — informational only — and any tool call needing that value will fail at runtime), (2) **quit and relaunch Claude Code** in the same directory, and (3) **approve the server** at the `Approve MCP server <name> from .mcp.json?` prompt. Claude Code only reads `mcpServers` at session start, and `.mcp.json` entries require explicit per-project approval (stored under `projects.<cwd>.enabledMcpjsonServers` in `~/.claude.json`). The "Project MCPs (.../.mcp.json)" section in `/mcp` only appears once at least one server in the file is approved. Verify with `/mcp` or `claude mcp list`.

To **enforce** the gateway as the only allowed transport in a project, add an `allowedMcpServers` policy to `.claude/settings.json`:

```json
{
  "allowedMcpServers": [
    {
      "serverCommand": [
        "npx",
        "--yes",
        "--registry",
        "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/",
        "@jfrog/mcp-gateway",
        "--server",
        "<JFROG_SERVER_ID>"
      ]
    }
  ]
}
```

To override the registry without editing the manifest, set `JFROG_MCP_GATEWAY_REPO` in your shell.

## Prerequisites

1. **JFrog Platform** access (Cloud or self-hosted).
2. **Node.js** (for `npx @jfrog/mcp-gateway` and the plugin's `SessionStart` hook).
3. **JFrog credentials** — either a `JFROG_ACCESS_TOKEN` / `JF_ACCESS_TOKEN` env var, or a server registered with the [JFrog CLI](https://jfrog.com/getcli) via `jf c add`. The gateway picks up either source automatically.
4. **JFrog CLI** (`jf`) is used by several skills for authentication and REST API operations. It can be installed automatically if missing, or manually via [Get JFrog CLI](https://jfrog.com/getcli) (installers and downloads) or the [Install JFrog CLI](https://docs.jfrog.com/integrations/docs/download-and-install-the-jfrog-cli) documentation for full steps and troubleshooting.

## Setup

### Local development

From a clone of this repository (repository root **is** the plugin root):

```bash
claude --plugin-dir /path/to/claude-plugin
```

After Claude Code starts, use `/help` to confirm skills under the `jfrog` namespace (for example `/jfrog:<skill-name>`). Run `/reload-plugins` after you change plugin files.

### Install from a marketplace

Plugins can be installed from catalogs described in [Discover and install plugins](https://docs.anthropic.com/en/discover-plugins) once this repo is listed (for example in the official directory after submission).

Authentication details (for example browser login with `jf`) are described in individual skills where they apply.

