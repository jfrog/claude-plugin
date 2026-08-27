# JFrog Plugin for Claude Code

JFrog plugin for [Claude Code](https://claude.com/product/claude-code): artifact management, security scanning, and supply-chain best practices, and Agent Guard.

## Features

The JFrog plugin provides the following capabilities, grouped by component:

| Component | Feature | Description |
| --- | --- | --- |
| **MCP** | JFrog MCP server | Remote JFrog MCP server auto-attached to every session via `.mcp.json` at `${JFROG_URL}/mcp` (OAuth, no API keys). |
| **Skill** | JFrog Platform | Interact with Artifactory repositories, builds, permissions, users, access tokens, projects, release bundles, and platform administration via the JFrog CLI and REST/GraphQL APIs. Also covers security audits, CVE lookups, and Advanced Security exposure queries. |
| **Skill** | Package safety & download | Check whether npm, Maven, PyPI, Go, and other packages are safe, curated, or allowed, then download them through Artifactory remote caches or curation-aware package managers. |
| **Hook + Skill** | Agent Package Resolution (Preview) | Automatically route packages installed by the AI agent through your organization's JFrog Artifactory, keeping agent-driven installs inside your Curation, Xray, and governance perimeter. |
| **Hook** | Plugin MCP rewrite | On SessionStart / FileChanged, rewrite discovered installed-plugin `.mcp.json` files through Agent Guard (`--rewrite-mcp-json`) so stdio MCP entries launch via `@jfrog/agent-guard`. |
| **Hook** | Skill Governance (Preview) | Evaluates the skills Claude invokes against your organization's JFrog skill governance policies, and blocks the ones that violate them — showing which policies were violated and the command to request a waiver. Enforcement runs in the JFrog Agent Guard; the hook only carries the event to it. |
| **Skill** | Agent Guard | Claude manages MCPs through the JFrog Agent Guard. Through the Agent Guard you can discover, install, configure, update, and remove MCP servers from the JFrog AI Catalog approved for your project, and authenticate to remote HTTP MCPs via OAuth, API key, or bearer token. |

> [!IMPORTANT]
> **Skill Governance blocks on policy, not on infrastructure.** Three outcomes, and they are
> distinct:
>
> - **Your JFrog policies deny the skill** — **blocked**, naming the policies it violated and the
>   command to request a waiver.
> - **The Agent Guard runs, but cannot reach a verdict in time** — **blocked**. It got as far as
>   the check and could not answer, so it does not guess.
> - **The Agent Guard cannot be *run at all*** — `npx` missing, the registry unreachable, no JFrog
>   server configured — **allowed**. A machine that cannot run the guard is not governed by it, and
>   blocking there would stop work without enforcing anything.
>
> A user who is entitled to nothing is unaffected either way: the Agent Guard returns "allow" for
> an unconfigured or unentitled user, so no setup is needed to opt out of the feature.

---

## Prerequisites

Before installing, make sure you have:

- **JFrog host URL and access token** — Your JFrog platform URL and a valid access token.
- **Claude Code CLI** (≥ 1.0) — The Claude Code CLI.
- **Node.js** (≥ 18) — with `npx` on your `PATH` (used by the Agent Guard). Without it Skill Governance cannot run, and governed actions are allowed unchecked.
- **Git Bash on Windows** — the Skill Governance hook runs as a Bash command so that it behaves identically on every platform. Install [Git for Windows](https://git-scm.com/downloads/win); without it the hook cannot run and governed actions are allowed unchecked. Not needed on macOS or Linux.
- **Skill runtime requirements** — `jf` CLI, `jq`, and `curl` on `PATH`, plus a configured JFrog instance. For the minimum versions, see the upstream skills [`Requirements`](https://github.com/jfrog/jfrog-skills/blob/v0.11.0/README.md#requirements). Configure the CLI with `jf config add` — see [Authentication](#authentication).
- **JFrog AI Catalog** (optional) — If you want to use the Agent Guard feature, your JFrog subscription needs to include the AI Catalog entitlement. Contact your JFrog account team if you're unsure whether it's enabled.
- **JFrog CLI ≥ 2.105.0** (optional) — If you want the Agent Guard to auto-resolve credentials/server ID from the JFrog CLI instead of `JFROG_URL`/`JFROG_ACCESS_TOKEN` env vars. Older CLIs don't support the `--format` flag used by `jf config show` for this.
- **JFrog project** (optional) — If you want to use the Agent Guard feature.

---

## Installation

### Install the Claude plugin

From the official Anthropic marketplace, inside Claude Code:

```
/plugin install jfrog@claude-plugins-official
```

Or from a terminal:

```bash
claude plugin install jfrog@claude-plugins-official
```

If install fails with a wall of `Invalid schema: plugins.N...` errors, those entries belong to **other** plugins in the shared official catalog, not JFrog. Claude Code validates the whole marketplace as one unit and does not refresh a stale local cache on install. Update the catalog and retry:

```bash
claude plugin marketplace update claude-plugins-official
claude plugin install jfrog@claude-plugins-official
```

### Local development

From a clone of this repository (repository root **is** the plugin root):

```bash
claude --plugin-dir /path/to/claude-plugin
```

---

## Authentication

### 1. Set persistent environment variables

| Variable | Description |
| --- | --- |
| `JFROG_URL` | Your JFrog platform URL, e.g. `https://mycompany.jfrog.io` (no trailing `/`) |
| `JFROG_ACCESS_TOKEN` | Your JFrog access token |

### 2. Configure the JFrog CLI

If you have never configured the JFrog CLI on this machine:

1. Open your terminal.
2. Run:
   ```bash
   jf config add
   ```
3. Follow the interactive prompts to enter the same JFrog platform URL and access token.

---

## Plugin MCP rewrite (Agent Guard)

On every Claude Code `SessionStart` (and when `installed_plugins.json` / `known_marketplaces.json` change), the plugin discovers installed-plugin `.mcp.json` paths under `$CLAUDE_CONFIG_DIR/plugins` (default `~/.claude`) — including marketplace live trees for string-source plugins — plus this plugin's own `.mcp.json` when present, and runs `npx @jfrog/agent-guard --rewrite-mcp-json` against those paths. Stdio MCP entries are rewritten to launch through Agent Guard; remote `url` / `http` / `sse` / `ws` entries are left unchanged. A fast SessionStart helper registers FileChanged `watchPaths` (skipped when the kill switch is on); the slower rewrite hook emits `/reload-plugins` guidance via `additionalContext` when files were updated.

The hook soft-fails (never breaks the session): missing project key, Agent Guard gate failure, or rewrite errors log and exit 0. Concurrent rewrite invocations share a lock file and soft-skip with status `busy`.

| Env | Purpose |
| --- | --- |
| `JF_AGENT_REWRITE_MCP_JSON_DISABLE=1` | Kill switch — skip rewrite and watchPaths registration |
| `JF_PROJECT` / `JFROG_PROJECT` | Project key (also inferred from existing `_JF_ARGS project=` in discovered mcp.json) |
| `JF_SERVER` / `JFROG_SERVER_ID` | Optional server ID for the gate / `--server` |
| `JFROG_AGENT_GUARD_VERSION` | Override pinned `@jfrog/agent-guard` version |
| `JFROG_AGENT_GUARD_REPO` | Private npm registry for `@jfrog/agent-guard` |
| `JFROG_AGENT_GUARD_BIN` | Local Agent Guard binary (skips npx) |
| `JF_ALIGN_MCP_JSON_ROOTS` | Override discovery roots (POSIX `:`/`,`; Windows `;`/`,`) |
| `JF_REWRITE_MCP_JSON_LOCK_PATH` | Override rewrite concurrency lock file path |
| `CLAUDE_CONFIG_DIR` | Claude config root (default `~/.claude`) |

---

## Agent Package Resolution (Preview)

> **Preview Notice:** This feature is in preview and licensed under the Apache License 2.0. For clarity: This software is provided "as-is" without warranty of any kind, and without support obligations or service level commitments. Behavior, APIs, conventions, and structure may change without notice between releases. JFrog makes no guarantees of backward compatibility during the preview release cycle. Use in production environments is at your own risk.

The plugin can now automatically route the packages your AI agent installs (npm, PyPI, Maven, Go, Docker, Helm, and NuGet) through your organization's JFrog Artifactory instead of public registries. This keeps agent-driven dependency installs inside your organization's governance perimeter.

Agent Package Resolution is in preview. The shipped template enables it with empty repository bindings (nothing is routed until Consent Enable or an admin adds `defaultGlobalRepos`). To get started:

- **Users:** see the [User Guide](docs/package-resolution-user-guide.md).
- **Admins:** see the [Admin Guide](docs/package-resolution-admin-guide.md).

---

## Usage

Once configured, interact with the JFrog plugin through natural language. Examples are grouped by capability.

### JFrog Platform skill

| Ask the agent… | What happens |
| --- | --- |
| "List my Artifactory repositories." | Returns repositories via the JFrog CLI. |
| "Upload this build to Artifactory." | Publishes build artifacts and metadata. |
| "Run a security audit on this project." | Runs an Xray / Advanced Security audit and summarizes findings. |
| "Show me details on CVE-2021-23337." | Looks up CVE details in JFrog Advanced Security. |
| "Create a scoped access token for CI." | Creates an access token with the requested scope. |
| "Promote this release bundle to production." | Uses Lifecycle / Distribution APIs to promote the bundle. |

### Package safety & download skill

| Ask the agent… | What happens |
| --- | --- |
| "Is `lodash@4.17.21` safe to install?" | Checks JFrog Public Catalog signals and curation policy for the package. |
| "Is this Maven package approved for use?" | Checks curation entitlement and policy for the requested package. |
| "Download `requests` via JFrog." | Resolves the package through an Artifactory remote cache or curation-aware package manager. |

### Agent Package Resolution

When Agent Package Resolution is enabled and configured, no special prompt syntax is required. Ask the agent to install or use a package as you normally would, and the plugin routes supported package operations through your organization's Artifactory.

| Ask the agent…                         | What happens                                                             |
| -------------------------------------- | ------------------------------------------------------------------------ |
| "Add `lodash` to this project."        | Resolves the npm package through the configured Artifactory repository.  |
| "Add Excel file import to this app."   | The agent selects a suitable package and resolves it through the configured Artifactory repository. |
| "Pull the `alpine` Docker image."      | Pulls the image through the configured Artifactory Docker repository.    |

### MCP server management (Agent Guard)

| Ask the agent… | What happens |
| --- | --- |
| "Which MCP servers can I install?" | Returns all MCP servers approved for your current project that you can install. |
| "What MCP servers do I already have?" | Returns only the MCP servers already installed on your machine. |
| "Show me the details for the filesystem MCP server." | Returns detailed metadata, required configuration (environment variables, runtime arguments), and active tool policies for a given server. |
| "Add the GitHub MCP server." | Installs an approved MCP server and syncs its tool policies locally. Secrets are requested via a CLI command — never in chat. |
| "Update the environment variables for the Slack MCP." | Replaces the configuration for an already-installed server without removing and reinstalling it. |
| "Remove the Slack MCP server." | Removes the server and its stored credentials from your local setup. Changes apply immediately. |
| "Log in to the remote Jira MCP server using OAuth." | Authenticates with a remote HTTP-based MCP server (OAuth, API key, or bearer token). |
| "Log out of the Jira MCP server." | Removes stored authentication credentials for a server. |

### How secrets are handled

When an MCP server requires a sensitive configuration, the agent cannot set the value directly. Instead, it returns a CLI command for you to copy and run in your terminal. Secrets such as API keys, tokens, and connection strings are never exposed in the agent chat history.

---

## Troubleshooting

### Plugin install fails with marketplace schema errors

`Invalid schema: plugins.0.source`, unrecognized `displayName`, and similar messages with numeric indices come from Claude Code rejecting the **entire** `claude-plugins-official` catalog because some other plugin's entry is invalid or your local copy is stale. They are not a diagnosis of this plugin.

Run `claude plugin marketplace update claude-plugins-official` to re-fetch the catalog, then retry `/plugin install jfrog@claude-plugins-official`.

For Agent Guard / MCP Registry issues, see the [JFrog MCP Registry troubleshooting guide](https://docs.jfrog.com/ai-ml/docs/mcp-registry-troubleshooting).

---

## Updating the vendored skills

The `skills/` tree is vendored from [`jfrog/jfrog-skills`](https://github.com/jfrog/jfrog-skills) at the version pinned in [`.github/scripts/sync-skills-vendor.json`](.github/scripts/sync-skills-vendor.json). To pull a newer upstream release into this repo:

1. Bump `pin` in `.github/scripts/sync-skills-vendor.json` to the new tag (e.g. `v0.12.0`).
2. Run the sync script from the repo root:

   ```bash
   node .github/scripts/sync-skills.mjs
   ```

   It downloads the pinned tarball from `codeload.github.com`, extracts it, and replaces the directories listed in `paths` (today: `skills/`).
3. Bump `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) so users actually receive the update — Claude Code skips installs whose resolved version hasn't changed.
4. Update the pinned-version link in the [Prerequisites](#prerequisites) section so the skill runtime requirements point at the new tag.
5. Commit the pin bump, the regenerated `skills/` tree, the version bump, and the README link bump together, and open a PR.

See [`VENDOR.md`](VENDOR.md) for the full picture.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, coding conventions, and the pull-request process.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## License

Licensed under the [Apache License 2.0](LICENSE).
