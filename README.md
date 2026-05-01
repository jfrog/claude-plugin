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

## Prerequisites

1. **JFrog Platform** access (Cloud or self-hosted).
2. **JFrog CLI** (`jf`) is used by several skills for authentication and REST API operations. It can be installed automatically if missing, or manually via [Get JFrog CLI](https://jfrog.com/getcli) (installers and downloads) or the [Install JFrog CLI](https://docs.jfrog.com/integrations/docs/download-and-install-the-jfrog-cli) documentation for full steps and troubleshooting.

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

