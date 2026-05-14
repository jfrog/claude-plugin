# JFrog MCP Integration for Claude Code

![JFrog](assets/logo.svg)

JFrog integration for [Claude Code](https://claude.com/product/claude-code): artifact management, security scanning, and supply-chain best practices — with all MCP servers installed exclusively through the **JFrog Agent Guard**.


## What's included

| Component | Path | Description |
| --- | --- | --- |
| **Manifest** | [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) | Plugin id `jfrog`, version, metadata. |
| **Skills** | [`skills/`](skills/) | `skills/<name>/SKILL.md`, invoked as `/jfrog:<name>` when the plugin is loaded. |

Skills are vendored from [jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills); the pinned **release and commit** are in [`skills/VENDOR.md`](skills/VENDOR.md).

---

## Prerequisites

Before installing, make sure you have:

- **JFrog Platform access** — Your JFrog subscription must include the AI Catalog entitlement. Contact your JFrog account team if you're unsure whether it's enabled.
- **JFrog project** — At least one MCP server allowed for your project.
- **JFrog host URL and access token** — Your JFrog platform URL and a valid access token.
- **Claude Code CLI** (≥ 1.0) — The Claude Code CLI or the official IDE extension installed.
- **Node.js** (≥ 14) — with `npx` on your `PATH` 
- **JFrog CLI** (≥ 2.x, optional) — Recommended for `jf config add` authentication (see [Authentication](#authentication)).
- **JFrog credentials** — Provided in one of two ways (see [Authentication](#authentication)):

---

## Installation

###  Install the Claude plugin

Inside Claude Code, run:

```
claude plugin install jfrog
```

### Verify

Run `/plugin` inside Claude and confirm the **Installed** tab shows the JFrog plugin at **v0.1.2 or higher**.

### Local development

From a clone of this repository (repository root **is** the plugin root):

```bash
claude --plugin-dir /path/to/claude-plugin
```

After Claude Code starts, use `/help` to confirm skills under the `jfrog` namespace (for example `/jfrog:<skill-name>`). Run `/reload-plugins` after you change plugin files.

---

## Authentication

The plugin reads JFrog credentials from environment variables or the JFrog CLI configuration. Pick **one** of the following.

### Option A — JFrog CLI (`jf config add`)

If you already have the JFrog CLI installed and configured, the plugin uses your existing authentication — no further setup is required.

**First-time setup only** (if you have never configured the JFrog CLI on this machine):

1. Open your terminal.
2. Run:
   ```bash
   jf config add
   ```
3. Follow the interactive prompts to enter your JFrog Platform URL and access token.
4. Restart your IDE / terminal to apply the changes.

### Option B — Persistent environment variables

Use this if you are not using the JFrog CLI. Set the following variables in your shell profile (macOS/Linux) or user environment (Windows), then fully restart VS Code:

| Variable             | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `JFROG_PLATFORM_URL` | Your JFrog platform URL, e.g. `https://mycompany.jfrog.io` |
| `JFROG_ACCESS_TOKEN` | Your JFrog access token                                    |

---

## Usage

### Discover, inspect, and install MCPs

| Ask the agent…                                          | What happens                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| "Which MCP servers can I install?"                      | Returns all MCP servers approved for your current project that you can install.                                                             |
| "What MCP servers do I already have?"                   | Returns only the MCP servers already installed on your machine.                                                                             |
| "Show me the details for the filesystem MCP server."    | Returns detailed metadata, required configuration (environment variables, runtime arguments), and active tool policies for a given server. |
| "Add the GitHub MCP server."                            | Installs an approved MCP server and syncs its tool policies locally. Secrets are requested via a CLI command — never in chat.               |
| "Update the environment variables for the Slack MCP."   | Replaces the configuration for an already-installed server without removing and reinstalling it.                                            |
| "Remove the Slack MCP server."                          | Removes the server and its stored credentials from your local setup. Changes apply immediately.                                             |
| "Log in to the remote Jira MCP server using OAuth."     | Authenticates with a remote HTTP-based MCP server (OAuth, API key, or bearer token).                                                        |
| "Log out of the Jira MCP server."                       | Removes stored authentication credentials for a server.                                                                                     |

### How secrets are handled

When an MCP server requires a sensitive configuration, the agent cannot set the value directly. Instead, it returns a CLI command for you to copy and run in your terminal. Secrets such as API keys, tokens, and connection strings are never exposed in the agent chat history.

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

Inside Claude Code, run:

```
/plugin uninstall jfrog@jfrog
```

The `SessionStart` hook stops running once the plugin is removed.

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
