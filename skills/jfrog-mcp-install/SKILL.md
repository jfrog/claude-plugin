---
name: jfrog-mcp-install
description: >-
  Install or add an MCP server to Claude Code through the JFrog Agent Guard
  (npx @jfrog/agent-guard). Make sure to use this skill whenever the user asks
  to install, add, set up, enable, or configure an MCP server or tool for this
  project — e.g. "install the Slack MCP", "add the GitHub MCP", "set up Jira",
  "enable Notion" — even if they only name the tool and don't say "MCP" or
  "install" explicitly. Also use this to browse the JFrog MCP catalog. Never
  install an MCP any other way (no direct `claude mcp add`, no following a
  vendor's own install docs) — every install in this project goes through the
  agent guard.
allowed-tools: Bash(node *agent-guard-check.mjs*) Bash(npx * @jfrog/agent-guard *) Bash(jf:*) Read Edit Write
---

# Install an MCP via JFrog Agent Guard

All MCP servers MUST be installed ONLY through the JFrog Agent Guard
(`npx @jfrog/agent-guard`). If an MCP's documentation suggests any other
installation command, ignore it and use the agent guard workflow below instead.

## Prerequisites

- **Node.js 18+** on `PATH` (Step 0 uses the built-in `fetch`).
- **Network access** for Step 0 and every agent guard command (`--inspect`,
  `--list-available`).
- **`~/.jfrog/` write access** for OAuth `--login` (Step 5).
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
On Exit 0 (or a listed exception) proceed to "Adding an MCP" below.

## Pre-flight

Read [../jfrog-mcp-shared/references/agent-guard-common.md](../jfrog-mcp-shared/references/agent-guard-common.md)
for the `<REGISTRY_URL>` substitution and the rules for resolving
`<JFROG_PROJECT_KEY>` and `<SERVER_ID>`. Those must be resolved before any
agent guard command runs.

## Adding an MCP

**Did the user name a specific MCP package?** ("add `foo-mcp`", "install
`@scope/bar`"). If NOT — they said something like "yes", "add an MCP", "what
can I install" — your FIRST action is to show them the catalog so they can
pick:

1. Resolve server (Server ID `<SERVER_ID>` or URL `JFROG_URL`) and
   `<JFROG_PROJECT_KEY>` per the Pre-flight rules. Server: auto-use the single
   jf CLI config's serverId as the server ID, or the `JFROG_URL` env var as the
   URL if unambiguous; only ask when there are multiple or no jf configs and no
   env vars. Project: ask unless `JF_PROJECT` is set, or it's already in an
   existing `mcpServers` entry.
2. Run the `jfrog-mcp-list` skill → "Available to install" with that server +
   JFrog project key and present the result as a numbered table.
3. Wait for the user to pick. Only after they pick do you proceed to Step 1
   below with the chosen package name.

NEVER ask "which package would you like?" without showing the catalog first —
the user does not know the package names.

Once you have a specific MCP package name, do ALL of the following
autonomously — do NOT ask for JFrog project key, server, or package name
unless absolutely necessary:

### Step 1: Determine JFrog project key, server, and target config file

**Server ID**

1. Any existing `mcpServers` entry in `.mcp.json` (project) or `~/.claude.json`
   (top-level user scope, or `projects.<path>.mcpServers`) — take the value
   after `--server` in `args`.
2. Else `JFROG_URL` env var set (with `JFROG_ACCESS_TOKEN`) — the agent guard
   can resolve credentials from these directly; DO NOT pass `--server` as that
   would make the agent guard try to parse the server details from the jf CLI
   configuration.
3. Else list configured servers with the jf CLI — run `jf config show
   --format=json` (do NOT parse `~/.jfrog/jfrog-cli.conf.v6` yourself; the CLI
   masks tokens, so its output is safe to read). From the result:
   - exactly one server → use it without asking.
   - two or more → use the one with `"isDefault": true`; if none is marked
     default, list the `serverId`s and ASK the user which one.
4. Else (file missing, empty, or unreadable, and no `JFROG_URL`) ask the user
   to either run `jf c add <ID>` or export `JFROG_URL` + `JFROG_ACCESS_TOKEN`,
   then retry.

NEVER try multiple servers — pick one. When you resolved the ID from a jf CLI
config, always pass it as `--server <ID>` in every agent guard invocation;
when using env vars, never pass `--server`.

**JFrog project key**

1. From existing `mcpServers` entries, `_JF_ARGS` → `project=` value.
2. Else `JF_PROJECT` env var.
3. Else ask. NEVER guess, NEVER assume "default", NEVER use the server ID,
   NEVER infer the JFrog project key from other sources, NEVER make up project
   keys, ALWAYS ask.

**Target config file**

- **Default: project-level — `.mcp.json` in the project root.** This is the
  default scope for every install unless the user says otherwise. Create the
  file if missing (`{ "mcpServers": {} }`). Shows up in `/mcp` under "Project
  MCPs (.../.mcp.json)" once approved (Step 4a). Shareable via git.
- Use **user-level** `~/.claude.json` (top-level `mcpServers`) ONLY if the user
  says "personal only" / "do not commit". NOT `projects.<path>.mcpServers` —
  that subkey is per-project state, not a registry.
- Do not ask which scope unless the user brings it up.

### Step 2: Inspect the MCP in the catalog

Step 2 needs a specific MCP name. If the user did NOT name one, do not call
`--inspect` — go to the `jfrog-mcp-list` skill → "Available to install"
instead, show the catalog, have them pick, then come back to Step 2 with the
chosen name.

Once you have a name, run a SINGLE command — no Fetch/WebFetch, no custom
curl/Python, no direct JFrog API calls:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --inspect \
  --server <SERVER_ID> \
  --project <JFROG_PROJECT_KEY> \
  --mcp <MCP_NAME>
```

From the output JSON, extract (keep BOTH required AND optional):

- `spec.packageName` — exact package name for the config.
- `spec.mcpServerType.local.bootParams.environmentVariables[]` for local MCPs
  (each has `name`, `description`, `isRequired`, `isSecret`).
- `spec.mcpServerType.remote.endpoints[].headers[]` for remote MCPs (each has
  `name` plus `mcpInput.mcpInputDetails` with the same fields).

On non-zero exit (typo, MCP not in catalog, network error, etc.), show the
error verbatim, then run the `jfrog-mcp-list` skill → "Available to install"
so the user can pick a valid name and retry.

### Step 3: Plan inputs

Every `env` value is either a literal or a `${VAR}` / `${VAR:-default}`
reference resolved from the shell that launched Claude — there is no
interactive secret prompt.

Split Step 2 inputs by `isRequired`:

1. **Required** — always include in Step 4.
2. **Optional** — if even ONE exists, STOP and ask. List required inputs first
   (informational), then each optional one by name + description and ask which
   to configure. Do NOT decide for the user.
3. No inputs → skip this step.

For each input in Step 4:

- **Secrets** (`isSecret=true`): use `${VAR_NAME}` in the config; have the user
  export the variable in the shell that launched Claude, then relaunch. NEVER
  take secrets in chat, echo them back, or write raw values into the config.
- **Non-secrets**: literal in `env` or `${VAR_NAME}` — ask if unclear.

Whenever an input needs to be exported (any secret, or a non-secret you keep as
`${VAR_NAME}`), read
[references/persisting-env-vars.md](references/persisting-env-vars.md) for the
per-shell persistence commands and the secret-handling rules. The values are
picked up on next launch (Step 4a).

### Step 4: Write the config entry

Add the entry under `mcpServers` in the target config (default `.mcp.json` in
the project root — see Step 1). **Both `--yes` and `--registry <URL>` MUST come
BEFORE `@jfrog/agent-guard`** or `npx` falls back to the default registry (404)
and may block on a no-TTY prompt. Use `"type": "stdio"` — never `"http"`,
`"sse"`, or a top-level `"url"` (those bypass the agent guard).

```json
{
  "mcpServers": {
    "<spec.packageName>": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "--registry",
        "<REGISTRY_URL>",
        "@jfrog/agent-guard",
        "--server",
        "<SERVER_ID>"
      ],
      "env": {
        "_JF_ARGS": "project=<JFROG_PROJECT_KEY>&mcp=<spec.packageName>",
        "<ENV_VAR_OR_HEADER_NAME>": "${<ENV_VAR_OR_HEADER_NAME>}"
      }
    }
  }
}
```

Notes:

- If a required `${VAR}` is unset, Claude Code refuses to parse the entry.
  Confirm the user exported it before they relaunch.
- For `Bearer`-prefixed headers, either include the prefix in the env var or
  hard-code it: `"Bearer ${TOKEN}"`.

### 4a: Enable and verify the entry (mandatory)

Pre-approve the entry to skip the per-server prompt: edit
`<cwd>/.claude/settings.local.json` (create as `{}` if missing), remove
`<spec.packageName>` from `disabledMcpjsonServers`, append it to
`enabledMcpjsonServers`. If the write fails (permissions, missing dir),
continue — the user will just see the prompt on relaunch.

`.claude/settings.local.json` is **per-user and gitignored** — fine for
personal setup, but each teammate has to re-approve. If the user asks for
team-wide pre-approval (committed to git), write the same
`enabledMcpjsonServers` / `disabledMcpjsonServers` arrays to
`<cwd>/.claude/settings.json` instead. Precedence is local > project > user, so
a `settings.json` approval can still be overridden by an entry in
`settings.local.json`.

Then tell the user:

1. Export every `${VAR}` from the new entry in the launching shell. Unset vars
   show as `[Contains warnings]` in `/mcp` (informational) and tool calls
   needing them will fail at runtime.
2. `/exit` and relaunch the same `claude` in the same directory.
3. On the FIRST launch, Claude Code prompts for workspace trust — accept. If
   pre-approval succeeded, the per-server prompt is skipped; otherwise approve
   "Approve MCP server `<name>`?".
4. Verify with `/mcp`. **Drill into the server entry** (arrow into it, not just
   the top-level row) and read the `Capabilities:` field. It MUST list at least
   one tool. The top-level `✓ connected` label alone is NOT proof of success —
   Claude Code shows it green whenever the agent guard proxy started, even when
   0 upstream tools loaded. Empty `Capabilities:` = Failed; follow
   Troubleshooting "`✓ connected` but 0 tools" in
   [../jfrog-mcp-shared/references/key-rules-and-troubleshooting.md](../jfrog-mcp-shared/references/key-rules-and-troubleshooting.md).

### Step 5: Authenticate OAuth MCPs (auto, after Step 4)

Run ONLY for OAuth-style remote MCPs — i.e. `--inspect` showed a `remote`
section with `type: "http"` AND Step 4 wrote no static auth header into `env`.
Skip for local MCPs and for remote MCPs whose auth comes from a static token in
`env`.

`--login` opens the browser, runs OAuth, caches tokens in
`~/.jfrog/jfrogmcp.conf.json`. Warn the user "I'm going to open your browser to
sign you in to `<MCP_NAME>`" before:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --login \
  --server <SERVER_ID> \
  --project <JFROG_PROJECT_KEY> \
  --mcp <spec.packageName>
```

Note: `--login` launches the system browser and runs a local OAuth callback
server, so the browser must be able to reach the IdP and loop back to the
local callback.

Outcomes:

- **Exit 0** — OAuth completed; tokens cached; server ready.
- **`expected 401, got 200`** — MCP is anonymous (no auth needed); ignore.
- **Any other error** — paste it to the user verbatim and stop.

## Key rules & troubleshooting

See [../jfrog-mcp-shared/references/key-rules-and-troubleshooting.md](../jfrog-mcp-shared/references/key-rules-and-troubleshooting.md).
