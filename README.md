# JFrog MCP Integration for Claude Code

![JFrog](assets/logo.svg)

JFrog integration for [Claude Code](https://claude.com/product/claude-code): artifact management, security scanning, and supply-chain best practices — with all MCP servers installed exclusively through the **JFrog MCP Gateway**.

This repository **is** the plugin: manifest at [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json), skills under [`skills/`](skills/).

## What's included

| Component | Path | Description |
| --- | --- | --- |
| **Manifest** | [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) | Plugin id `jfrog`, version, metadata. |
| **Skills** | [`skills/`](skills/) | `skills/<name>/SKILL.md`, invoked as `/jfrog:<name>` when the plugin is loaded. |
| **MCP Gateway hook** | [`hooks/hooks.json`](hooks/hooks.json), [`scripts/inject-instructions.mjs`](scripts/inject-instructions.mjs), [`templates/jfrog-mcp-management.md`](templates/jfrog-mcp-management.md) | A `SessionStart` hook that injects MCP-management instructions into Claude's context so MCP servers can only be added/removed/listed through the **JFrog MCP Gateway** (`@jfrog/mcp-gateway`). |

Skills are vendored from [jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills); the pinned **release and commit** are in [`skills/VENDOR.md`](skills/VENDOR.md).

---

## Prerequisites

Before installing, make sure you have:

- **JFrog Platform access** — An active account with the AI Catalog enabled.
- **JFrog project** — At least one MCP server allowed for your project.
- **JFrog host URL and access token** — Your JFrog platform URL and a valid access token.
- **Claude Code CLI** (≥ 1.0) — The Claude Code CLI or the official IDE extension installed.
- **Node.js** (≥ 18) — with `npx` on your `PATH` — required so the `mcp-gateway` can be fetched on demand.
- **JFrog CLI** (≥ 2.x, optional) — Recommended for `jf config add` authentication (see [Authentication](#authentication)).
- **JFrog credentials** — Provided in one of two ways (see [Authentication](#authentication)):
  - `jf config add` via the JFrog CLI (recommended), **or**
  - `JFROG_URL` + `JFROG_ACCESS_TOKEN` environment variables.

---

## Installation

### 1. Add the marketplace

Inside Claude Code, run:

```
/plugin marketplace add jfrog/claude-plugin
```

### 2. Install the plugin

```
/plugin install jfrog@jfrog
```

### 3. Launch Claude with the plugin force-enabled (optional)

By default the plugin's `SessionStart` hook self-disables unless the **`mcp_gateway_plugin_enabled`** account setting is enabled in your JFrog Platform. To force-enable locally for testing:

```bash
JF_MCP_GATEWAY_FORCE_ENABLE=true claude
```

### 4. Verify

Run `/plugin` inside Claude and confirm the **Installed** tab shows the JFrog plugin at **v0.1.2 or higher**.

### Local development

From a clone of this repository (repository root **is** the plugin root):

```bash
claude --plugin-dir /path/to/claude-plugin
```

After Claude Code starts, use `/help` to confirm skills under the `jfrog` namespace (for example `/jfrog:<skill-name>`). Run `/reload-plugins` after you change plugin files.

---

## Authentication

The plugin reads JFrog credentials from environment variables or the JFrog CLI configuration to decide whether to inject MCP-Gateway instructions. Pick **one** of the following.

### Option A — Environment variables

Use this if you are not using the JFrog CLI. Both variables must be set together.

| Variable              | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `JFROG_URL`           | Your JFrog platform URL, e.g. `https://mycompany.jfrog.io` |
| `JFROG_ACCESS_TOKEN`  | Your JFrog access token                                    |
| `JF_PROJECT` *(opt.)* | Default project key. If unset, the agent asks when needed. |

**macOS / Linux (zsh or bash):**

```bash
echo 'export JFROG_URL="https://<your-host>"'          >> ~/.zshrc
echo 'export JFROG_ACCESS_TOKEN="<your-token>"'        >> ~/.zshrc
# Optional:
# echo 'export JF_PROJECT="<your-project-key>"'        >> ~/.zshrc
source ~/.zshrc
```

Restart your IDE / terminal after setting the variables so the new environment is picked up.

**Windows (PowerShell):**

```powershell
setx JFROG_URL "<your-platform-url>"
setx JFROG_ACCESS_TOKEN "<your-access-token>"
# Optional:
# setx JF_PROJECT "<your-project-key>"
```

Close and reopen your IDE / terminal for `setx` to take effect.

> **Security:** If you use a `.env` file for local development, add it to `.gitignore` so your access token is never committed.

### Option B — JFrog CLI (`jf config add`)

```bash
jf config add
```

Follow the prompts to enter your JFrog Platform URL and access token, then restart your IDE / terminal.

---

## Usage

After authentication, open a workspace in Claude Code. The plugin's `SessionStart` hook injects MCP-management instructions and the MCP servers approved for your project become available in chat. Examples:

| Ask the agent…                                        | What happens                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| "Which MCP servers can I install?"                    | Lists servers approved for your current project.                                              |
| "Show me the details for the filesystem MCP server."  | Returns metadata, required env vars, and active tool policies.                                |
| "Add the GitHub MCP server."                          | Installs it and syncs tool policies. Secrets are requested via a CLI command — never in chat. |
| "Remove the Slack MCP server."                        | Uninstalls the server and its stored credentials.                                             |
| "Switch my project to `backend-team`."                | Re-syncs approved servers and policies for the new project.                                   |
| "Which JFrog project am I working in?"                | Shows the active project and the others you can access.                                       |

**How secrets are handled.** When a server's metadata marks a value as `isSecret`, the agent will not set it directly — instead it returns a CLI command for you to run locally, so tokens and connection strings never appear in chat history.

---

## Troubleshooting

### The hook doesn't inject MCP-management instructions

The `SessionStart` hook silently exits unless the gateway is enabled. Check, in order:

1. `JFROG_URL` and `JFROG_ACCESS_TOKEN` are set in the environment Claude is launched from.
2. The `mcp_gateway_plugin_enabled` account setting is enabled in your JFrog Platform.
3. To bypass the settings check for local testing, launch Claude with `JF_MCP_GATEWAY_FORCE_ENABLE=true`.
4. To see why the hook decided to skip, launch with `JF_AGENT_GUARD_DEBUG=true claude` — debug logs are written to stderr with the `[jfrog-agent-guard]` prefix.

### MCP failed to start

The plugin does not install runtimes. Ensure you have Docker, Python, or Node installed locally as required by the specific MCP server, and that any required environment variables are configured.

### Tools are not appearing in my agent chat

Permissions are project-specific. Make sure the MCP is allowed for the specific project configured in your environment (`JF_PROJECT`) and that any tool policies are not blocking the tools you expect.

### Uninstall the plugin

Run `/plugin uninstall jfrog@jfrog` inside Claude Code. The `SessionStart` hook stops running once the plugin is removed.

### Getting help

If you continue to experience issues:

1. Reproduce with `JF_AGENT_GUARD_DEBUG=true` and capture the stderr output from the hook.
2. Note any HTTP status codes returned by the JFrog Platform settings endpoint.
3. Open a [GitHub issue](https://github.com/jfrog/claude-plugin/issues) or contact JFrog support at <devrel@jfrog.com> with the collected information.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, coding conventions, and the pull-request process.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## License

Licensed under the [Apache License 2.0](LICENSE).
