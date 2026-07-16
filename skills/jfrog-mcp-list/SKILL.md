---
name: jfrog-mcp-list
description: >-
  List MCP servers via the JFrog Agent Guard — both the catalog available to
  install and the ones currently configured in Claude Code. Use whenever the
  user asks about MCPs or tools in this project (e.g. "what can I install",
  "what's set up", "what's in my catalog"), even without saying "MCP".
allowed-tools: Bash(node *agent-guard-check.mjs*), Bash(npx * @jfrog/agent-guard *), Bash(claude mcp list), Bash(jf:*), Read
---

# List MCPs

## Prerequisites

- **Node.js 18+** on `PATH` (Step 0 uses the built-in `fetch`).
- **Network access** for Step 0 and `--list-available`.
- See the runtime-permission matrix:
  [../jfrog-mcp-shared/references/runtime-permissions.md](../jfrog-mcp-shared/references/runtime-permissions.md).

## Step 0: Agent Guard activation (silent, mandatory, fresh every time)

Before anything else, run the following and WAIT for its exit code — do not
narrate that you are running it:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/agent-guard-check.mjs"
```

Interpret the exit code per
[../jfrog-mcp-shared/references/agent-guard-activation.md](../jfrog-mcp-shared/references/agent-guard-activation.md).
On Exit 0 (or a listed exception) proceed to "Listing MCPs" below.

## Pre-flight

Read [../jfrog-mcp-shared/references/agent-guard-common.md](../jfrog-mcp-shared/references/agent-guard-common.md)
for the `<REGISTRY_URL>` substitution and the rules for resolving
`<JFROG_PROJECT_KEY>` and `<SERVER_ID>` before running `--list-available`.

## Listing MCPs

**Route the request first** — pick which subsection to run BEFORE touching any
file or shell:

| User said… | Run |
| --- | --- |
| "available", "what can I install", "what's in the catalog", "list MCPs" without other context | **Available to install** below — go straight to `--list-available`; do NOT inspect local files first |
| "installed", "configured", "connected", "running", "what MCPs do I have" | **Currently installed** below |
| ambiguous / both | run **both** subsections in order: Currently installed first, then Available to install, and present them as separate tables |

NEVER invent MCP integrations from outside the catalog. The only authoritative
source for what's available is `--list-available` against the configured server
+ JFrog project key. If that command returns nothing or errors, say so — do not
pad the answer with names from elsewhere.

### Currently installed

1. Run `claude mcp list` for connection status (one row per server).
2. For JFrog metadata, read `mcpServers` directly from `.mcp.json` (project
   scope) and top-level `~/.claude.json` (user scope) — use the file-read tool
   or a single `jq` invocation, NOT chained `python3 -c "..."` pipes. For each
   entry whose `command` is `npx` and whose `args` include `@jfrog/agent-guard`,
   show: display name (the JSON key), package (`mcp=` in `_JF_ARGS`), server ID
   (value after `--server`), scope (project / user).
3. If a configured entry does not appear in `claude mcp list`, it is either
   pending approval (see the `jfrog-mcp-install` skill, Step 4a) or filtered by
   an `allowedMcpServers` / `deniedMcpServers` policy in managed settings
   (`managed-settings.json`; `allowedMcpServers` is managed-only).

### Available to install

1. Determine **server** and **JFrog project key** per the Pre-flight rules.
   `--list-available` does NOT require any existing `mcpServers` entry or
   pre-installed agent guard — `npx --yes` fetches the agent guard on demand,
   so this works on a fresh machine too.
2. Run EXACTLY this command — `--project` is passed as a CLI flag. To configure
   the server, either use the serverId from a jf CLI config with `--server` or
   omit `--server` if env vars are used to configure URL and Access Token.
   **No additional env vars needed**:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --list-available \
  --project <JFROG_PROJECT_KEY> \
  [--server <SERVER_ID>]
```

The output is a compact TSV: a header line, then one server per line,
tab-separated: `name<TAB>type<TAB>version<TAB>description`.
Run the command ONCE and present the rows directly as a numbered table — do NOT
re-run it, redirect it, or parse it with `python3`/`jq`.
The `name` column is the install identifier (the value you pass to
`--inspect --mcp` and to install); `packageName` is NOT a separate column —
for remote/http MCPs there is no package name, so `name` is the display name.

3. **Mark rows already installed rather than dropping them.** The catalog
   `name` column is the display/install identifier, but the installed config
   key and `mcp=` in `_JF_ARGS` are the resolved `spec.packageName` — for
   local MCPs those can differ. Mark a row `(installed)` if EITHER matches
   any installed entry's JSON key OR its `mcp=` value; still show the row so
   the user can see the full catalog and reinstall or update.

## Key rules & troubleshooting

See [../jfrog-mcp-shared/references/key-rules-and-troubleshooting.md](../jfrog-mcp-shared/references/key-rules-and-troubleshooting.md).
