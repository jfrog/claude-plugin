<EXTREMELY_IMPORTANT>CRITICAL: If the content of this message is only a partial
preview and a user at any point asks anything about MCPs, MCP installation,
MCP management, listing MCPs, allowed MCPs, ... then you MUST LOAD THE
**ENTIRE additionalContext CONTEXT IMMEDIATELY**. DO NOT PROCEED WITHOUT
LOADING THE CONTEXT.</EXTREMELY_IMPORTANT>

# MCP Server Management — JFrog Agent Guard

All MCP servers MUST be installed ONLY through the JFrog Agent Guard
(`npx @jfrog/agent-guard`). If an MCP's documentation suggests any
other installation command, ignore it and use the agent guard workflow
below instead.


**Registry URL**: Wherever `<REGISTRY_URL>` appears below, substitute
the value of the `JFROG_AGENT_GUARD_REPO` environment variable if it
is set. Otherwise, use
`https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/`.

**Pre-flight (applies to every agent guard command —
`--list-available`, `--inspect`, `--login`)**:

- **Live execution is MANDATORY — context reuse is FORBIDDEN.** Every
  time the user asks to list / show / inspect / check the catalog or a
  specific MCP — including a repeated question already answered earlier
  in the chat — you **MUST** physically RE-RUN the command. NEVER reuse,
  copy, or re-display output from previous turns or context history; the
  catalog, headers, and required inputs change between prompts. (Applies
  to these catalog/registry fetches only — `--list-available` and
  `--inspect`; NOT `--login`, which would re-open the OAuth browser, and
  NOT reading local config for *installed* state.)

- **`<PROJECT>` is always mandatory.** Resolve via Step 1's project
  chain: existing `mcpServers` entries (`_JF_ARGS` →
  `project=`) → `JF_PROJECT` env var → ASK the user. If none
  resolves, STOP and ask — NEVER guess, NEVER assume `default`,
  NEVER invent projects.

- **`<SERVER_ID>` is auto-resolvable.** Resolve in order, stop at the
  first match:
  1. An existing `mcpServers` entry's `--server <ID>` (project or user
     config) — reuse it.
  2. `JFROG_URL` + `JFROG_ACCESS_TOKEN` set in the env — use them and do
     NOT pass `--server` (the agent guard reads the env directly).
  3. List configured servers with the jf CLI — `jf config show --format=json`
     (do NOT parse `~/.jfrog/jfrog-cli.conf.v6`; the CLI masks tokens, so
     its output is safe). Exactly one → use it; two or more → use the one
     with `"isDefault": true`; if none is marked default → ASK the user
     which one. Then pass `--server <ID>`.
  4. None of the above → ask the user to run `jf c add <ID>` or export
     `JFROG_URL` + `JFROG_ACCESS_TOKEN`, then retry.

  When you resolved the ID from a jf CLI config, always pass it as
  `--server <ID>`; when using env vars, never pass `--server`.
- The commands need network access to the npm registry and the JFrog
  platform. A corporate proxy, VPN, or blocked registry can surface as
  `Forbidden` / `403` errors.

Once both are determined, proceed. If either is still unknown,
STOP — do NOT run the command with guesses.

## Adding an MCP

**Did the user name a specific MCP package?** ("add `foo-mcp`",
"install `@scope/bar`"). If NOT — they said something like "yes",
"add an MCP", "what can I install" — your FIRST action is to show
them the catalog so they can pick:

1. Resolve server (Server ID `<SERVER_ID>` or URL `JFROG_URL`)
   and `<PROJECT>` per the Pre-flight rule at the top of this document.
   Server: auto-use the single jf CLI configs serverId as the server ID
   or the `JFROG_URL` env var as the URL if unambiguous; only ask when
   there are multiple or no jf configs and no env vars.
   Project: Ask unless `JF_PROJECT` is set, or it's already in an
   existing `mcpServers` entry.
2. Run "Listing MCPs > Available to install" with that server +
   project and present the result as a numbered table.
3. Wait for the user to pick. Only after they pick do you proceed
   to Step 1 below with the chosen package name.

NEVER ask "which package would you like?" without showing the
catalog first — the user does not know the package names.

Once you have a specific MCP package name, do ALL of the following
autonomously — do NOT ask for project, server, or package name
unless absolutely necessary:

### Step 1: Determine project, server, and target config file

**Server ID**

1. Any existing `mcpServers` entry in `.mcp.json` (project) or
   `~/.claude.json` (top-level user scope, or
   `projects.<path>.mcpServers`) — take the value after `--server`
   in `args`.
2. Else `JFROG_URL` env var set (with `JFROG_ACCESS_TOKEN`) — the
   agent guard can resolve credentials from these directly;
   DO NOT pass `--server` as that would make the agent guard try to
   parse the server details from the jf cli configuration.
3. Else list configured servers with the jf CLI — run
   `jf config show --format=json` (do NOT parse
   `~/.jfrog/jfrog-cli.conf.v6` yourself; the CLI masks tokens, so its
   output is safe to read). From the result:
   - exactly one server → use it without asking.
   - two or more → use the one with `"isDefault": true`; if none is
     marked default, list the `serverId`s and ASK the user which one.
4. Else (file missing, empty, or unreadable, and no `JFROG_URL`)
   ask the user to either run `jf c add <ID>` or export
   `JFROG_URL` + `JFROG_ACCESS_TOKEN`, then retry.

NEVER try multiple servers — pick one. When you resolved the ID from a
jf CLI config, always pass it as `--server <ID>` in every agent guard
invocation; when using env vars, never pass `--server`.

**Project**

1. From existing `mcpServers` entries, `_JF_ARGS` →
   `project=` value.
2. Else `JF_PROJECT` env var.
3. Else ask. NEVER guess, NEVER assume "default", NEVER use the server ID,
   NEVER infer the project from other sources, NEVER make up projects,
   ALWAYS ask.

**Target config file**

- **Default: `.mcp.json` in the project root.** Create it if missing
  (`{ "mcpServers": {} }`). Shows up in `/mcp` under "Project MCPs
  (.../.mcp.json)" once approved (Step 4a). Shareable via git.
- Use `~/.claude.json` (top-level `mcpServers`) ONLY if the user says
  "personal only" / "do not commit". NOT `projects.<path>.mcpServers`
  that subkey is per-project state, not a registry.
- Do not ask which scope unless the user brings it up.

### Step 2: Inspect the MCP in the catalog

Step 2 needs a specific MCP name. If the user did NOT name one, do
not call `--inspect` — go to "Listing MCPs > Available to install"
instead, show the catalog, have them pick, then come back to Step 2
with the chosen name.

Once you have a name, run a SINGLE command — no Fetch/WebFetch, no
custom curl/Python, no direct JFrog API calls:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --inspect \
  --server <SERVER_ID> \
  --project <PROJECT> \
  --mcp <MCP_NAME>
```

From the output JSON, extract (keep BOTH required AND optional):

- `spec.packageName` — exact package name for the config.
- `spec.mcpServerType.local.bootParams.environmentVariables[]` for
  local MCPs (each has `name`, `description`, `isRequired`, `isSecret`).
- `spec.mcpServerType.remote.endpoints[].headers[]` for remote MCPs
  (each has `name` plus `mcpInput.mcpInputDetails` with the same
  fields).

On non-zero exit (typo, MCP not in catalog, network error, etc.),
show the error verbatim, then run `--list-available` (see "Listing
MCPs") so the user can pick a valid name and retry.

### Step 3: Plan inputs

Every `env` value is either a literal or a `${VAR}` / `${VAR:-default}`
reference resolved from the shell that launched Claude — there is
no interactive secret prompt.

Split Step 2 inputs by `isRequired`:

1. **Required** — always include in Step 4.
2. **Optional** — if even ONE exists, STOP and ask. List required
   inputs first (informational), then each optional one by name +
   description and ask which to configure. Do NOT decide for the
   user.
3. No inputs → skip this step.

For each input in Step 4:

- **Secrets** (`isSecret=true`): use `${VAR_NAME}` in the config;
  tell the user to export it for the current session via
  `read -rs VAR_NAME && export VAR_NAME && echo exported`.
  For persistence, the right startup file depends on the user's
  **shell**, not their OS — macOS and Linux both commonly run zsh or
  bash. Detect the shell (e.g. `echo "$SHELL"`) and add the export to
  the file that shell loads on startup:
  - **zsh** (the macOS default) → `~/.zshrc`
  - **bash** → `~/.bashrc`; note macOS login shells read
    `~/.bash_profile`, which usually sources `~/.bashrc`
  - **fish** → `~/.config/fish/config.fish` (use `set -gx`)
  - **Windows** → use `setx VAR_NAME "<value>"` (PowerShell/CMD)
    instead of the `read`/`export` snippet
  If unsure which file the shell sources, ask the user. Values are
  picked up on next launch (Step 4a). NEVER take secrets in chat, echo
  them back, or write raw values into config.
- **Non-secrets**: literal in `env` or `${VAR_NAME}` — ask if unclear.

### Step 4: Write the config entry

Add the entry under `mcpServers` in the target config (default
`.mcp.json` — see Step 1).
**Both `--yes` and `--registry <URL>` MUST come BEFORE
`@jfrog/agent-guard`** or `npx` falls back to the default
registry (404) and may block on a no-TTY prompt. Use
`"type": "stdio"` — never `"http"`, `"sse"`, or a top-level `"url"`
(those bypass the agent guard).

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
        "_JF_ARGS": "project=<PROJECT>&mcp=<spec.packageName>",
        "<ENV_VAR_OR_HEADER_NAME>": "${ENV_VAR_OR_HEADER_NAME}"
      }
    }
  }
}
```

Notes:

- If a required `${VAR}` is unset, Claude Code refuses to parse the
  entry. Confirm the user exported it before they restart.
- For `Bearer`-prefixed headers, either include the prefix in the env
  var or hard-code it: `"Bearer ${TOKEN}"`.

### 4a: Enable the entry (mandatory)

Pre-approve the entry to skip the per-server prompt: edit
`<cwd>/.claude/settings.local.json` (create as `{}` if missing),
remove `<spec.packageName>` from `disabledMcpjsonServers`, append it
to `enabledMcpjsonServers`. If the write fails (permissions, missing
dir), continue — the user will just see the prompt on relaunch.

`.claude/settings.local.json` is **per-user and gitignored** — fine
for personal setup, but each teammate has to re-approve. If the user
asks for team-wide pre-approval (committed to git), write the same
`enabledMcpjsonServers` / `disabledMcpjsonServers` arrays to
`<cwd>/.claude/settings.json` instead. Precedence is local >
project > user, so a `settings.json` approval can still be
overridden by an entry in `settings.local.json`.

Then tell the user:

1. Export every `${VAR}` from the new entry in the launching shell.
   Unset vars show as `[Contains warnings]` in `/mcp` (informational)
   and tool calls needing them will fail at runtime.
2. `/exit` and relaunch the same `claude` in the same directory.
3. On the FIRST launch, Claude Code prompts for workspace trust —
   accept. If pre-approval succeeded, the per-server prompt is
   skipped; otherwise approve "Approve MCP server `<name>`?".
4. Verify with `/mcp`. **Drill into the server entry** (arrow into
   it, not just the top-level row) and read the `Capabilities:`
   field. It MUST list at least one tool. The top-level `✓ connected`
   label alone is NOT proof of success — Claude Code shows it green
   whenever the agent guard proxy started, even when 0 upstream tools
   loaded. Empty `Capabilities:` = Failed; follow Troubleshooting
   "`✓ connected` but 0 tools".

If a previous rejection is sticking and you can't get back to
"approved", see Troubleshooting "MCP still appears as approved (or
won't go away) after editing `.mcp.json`".

### Step 5: Authenticate OAuth MCPs (auto, after Step 4)

Run ONLY for OAuth-style remote MCPs — i.e. `--inspect` showed a
`remote` section with `type: "http"` AND Step 4 wrote no static auth
header into `env`. Skip for local MCPs and for remote MCPs whose
auth comes from a static token in `env`.

`--login` opens the browser, runs OAuth, caches tokens in
`~/.jfrog/jfrogmcp.conf.json`. Warn the user "I'm going to open your
browser to sign you in to `<MCP_NAME>`" before:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --login \
  --server <SERVER_ID> \
  --project <PROJECT> \
  --mcp <spec.packageName>
```

Note: `--login` launches the system browser and runs a local OAuth
callback server, so the browser must be able to reach the IdP and loop
back to the local callback.

Outcomes:

- **Exit 0** — OAuth completed; tokens cached; server ready.
- **`expected 401, got 200`** — MCP is anonymous (no auth needed);
  ignore.
- **Any other error** — paste it to the user verbatim and stop.

## Removing an MCP

1. Delete the entry from `mcpServers` in the file it was installed
   in (`.mcp.json` or top-level `~/.claude.json`).
2. If OAuth was used (Step 5), also remove its entry from
   `~/.jfrog/jfrogmcp.conf.json`.
3. Tell the user to relaunch Claude Code so the removed entry stops
   loading (`mcpServers` is read at session start only).

## Listing MCPs

**Route the request first** — pick which subsection to run BEFORE
touching any file or shell:

| User said… | Run |
| --- | --- |
| "available", "what can I install", "what's in the catalog", "list MCPs" without other context | **Available to install** below — go straight to `--list-available`; do NOT inspect local files first |
| "installed", "configured", "connected", "running", "what MCPs do I have" | **Currently installed** below |
| ambiguous / both | run **both** subsections in order: Currently installed first, then Available to install, and present them as separate tables |

NEVER invent MCP integrations from outside the catalog. The only
authoritative source for what's available is `--list-available`
against the configured server + project. If that command returns
nothing or errors, say so — do not pad the answer with names from
elsewhere.

### Currently installed

1. Run `claude mcp list` for connection status (one row per server).
2. For JFrog metadata, read `mcpServers` directly from `.mcp.json`
   (project scope) and top-level `~/.claude.json` (user scope) —
   use the file-read tool or a single `jq` invocation, NOT chained
   `python3 -c "..."` pipes. For each entry whose `command` is `npx`
   and whose `args` include `@jfrog/agent-guard`, show: display name
   (the JSON key), package (`mcp=` in `_JF_ARGS`), server
   ID (value after `--server`), scope (project / user).
3. If a configured entry does not appear in `claude mcp list`, it is
   either pending approval (see Step 4a) or filtered by an
   `allowedMcpServers` / `deniedMcpServers` policy in managed
   settings (`managed-settings.json`; `allowedMcpServers` is
   managed-only).

### Available to install

1. Determine **server** and **project** per the Pre-flight rule at
   the top of this document. `--list-available` does NOT require
   any existing `mcpServers` entry or pre-installed agent guard —
   `npx --yes` fetches the agent guard on demand, so this works on a
   fresh machine too.
2. Run EXACTLY this command — `--project` is passed as a CLI flag
   To configure the server, either use the serverId from a jf cli
   config with `--server` or omit `--server` if env vars are used to
   configure URL and Access Token. **no additional env vars needed**:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --list-available \
  --project <PROJECT> \
  [--server <SERVER_ID>]
```

The output is a compact TSV: a header line, then one server per line,
tab-separated: `name<TAB>type<TAB>version<TAB>description`.
Run the command ONCE and present the rows directly as a numbered
table — do NOT re-run it, redirect it, or parse it with `python3`/`jq`.
The `name` column is the install identifier (the value you pass to
`--inspect --mcp` and to install); `packageName` is NOT a separate
column — for remote/http MCPs there is no package name, so `name` is
the display name.

3. Filter out any `name` already present in the installed list
   (compare against `mcp=` in `_JF_ARGS`). Mark the rest as
   available to install.

## Key Rules

- **Package scope is case-sensitive — ALWAYS write it lowercase as
  `@jfrog/agent-guard`, NEVER `@JFrog/agent-guard`.** npm scopes are
  case-sensitive; the published package is the lowercase
  `@jfrog/agent-guard`. Capitalizing the brand (`@JFrog`) points at a
  different/nonexistent scope and breaks the command. Use the exact
  lowercase string in every command and config entry.
- **`npx` arg order:** `--yes`, `--registry <URL>`,
  `@jfrog/agent-guard`, then agent guard flags. Both `--yes` and
  `--registry` MUST precede the package name or `npx` falls back to
  the default registry (404) and may block on a no-TTY prompt.
- **Always `"type": "stdio"`** pointing at `npx @jfrog/agent-guard`,
  even for remote-only catalog MCPs (the agent guard proxies them).
  `"http"`, `"sse"`, or a top-level `"url"` bypass the agent guard.
- `_JF_ARGS` is **only** for the entry Claude Code launches
  at session start (Step 4's `mcpServers.*.env`); MUST contain
  `project=<NAME>&mcp=<PACKAGE_NAME>`.
  NEVER pass `_JF_ARGS` to `--list-available`,
  `--inspect`, or `--login` — those take `--server` / `--project`
  as CLI flags only.
- NEVER assume `default` as a project name. If the project is unknown
  after Step 1's chain (existing `mcpServers` entries → `JF_PROJECT`
  env var), STOP and ask the user. Same for server ID if used.
  NEVER invent or guess projects or server IDs.
- Package name MUST come from the catalog (`--inspect` /
  `--list-available`). NEVER guess. NEVER install MCPs outside the
  agent guard. NEVER use Fetch/WebFetch for catalog calls.
- NEVER pipe a catalog command through `python3`, and NEVER capture it
  with `2>&1` — `npx`/`npm` writes progress to stderr, which corrupts
  the output stream. For `--list-available` present the compact TSV it
  prints; for `--inspect` read the JSON it prints on stdout
  directly (or with a single `jq` filter), never via `python3`.
- NEVER write a raw secret into `.mcp.json` or `~/.claude.json` —
  always `${ENV_VAR}`. NEVER show tokens / API keys.
- NEVER try multiple servers — ask the user to pick one.

## Troubleshooting

- **`✓ connected` but 0 tools (empty `Capabilities:` when you drill
  into `/mcp`)** — agent guard proxy started, upstream MCP did not.
  Top-level `✓ connected` is misleading here. NEVER report success 
  when there are 0 tools.
  1. Relaunch with `claude --debug` and read the agent guard stderr in the
     logs panel; diagnose by MCP type:
     - **OAuth (remote)** — re-run Step 5 (`--login`); refresh token
       likely expired.
     - **Static-token (remote)** — confirm every `${VAR}` in `env` is
       exported in the launching shell and the token is still valid.
     - **Local (stdio)** — check that the bundled binary actually
       launched (agent guard stderr will show the spawn error).
  2. Verify that the mcp server is still allowed.
     See "Listing MCPs > Available to install".
- **`.mcp.json` server missing from `/mcp`** — rejected. See Step 4a.
- **MCP still appears as approved (or won't go away) after editing
  `.mcp.json`** — approval state lives in plain JSON arrays read at
  session start; nothing is cached, so `npm cache clean` is
  unrelated. Check, in precedence order:
  1. `<cwd>/.claude/settings.local.json` — per-user, gitignored.
     Where Step 4a writes by default.
  2. `<cwd>/.claude/settings.json` — team-shared, committed to git.
  3. `~/.claude/settings.json` — user-global, applies to every
     repo.
  4. `~/.claude.json` → `projects["<absolute cwd>"]
     .enabledMcpjsonServers` / `disabledMcpjsonServers` — separate
     runtime store Claude Code writes when the user clicks
     *approve* / *reject* on the interactive prompt. NOT cleared by
     `reset-project-choices`.
  5. Managed `managed-settings.json` (`/Library/Application
     Support/ClaudeCode/` on macOS, `/etc/claude-code/` on Linux,
     `%ProgramData%\ClaudeCode\` on Windows) — can't be overridden.

  Also check `enableAllProjectMcpServers: true` in any of (1)–(3) —
  that auto-approves every entry in `.mcp.json`. Membership in any
  `enabledMcpjsonServers` array is enough to skip the prompt, so to
  truly revoke, remove the entry from every file that lists it (and
  optionally add to `disabledMcpjsonServers` to explicitly block),
  then `/exit` and relaunch.
- **Missing from `claude mcp list`** — JSON parse failure (often an
  undefined `${VAR}`), or an `allowedMcpServers` / `deniedMcpServers`
  policy in managed settings (`managed-settings.json`) filtering the
  entry.
- **Agent Guard: `multiple/no JFrog server configured`** (the agent guard
  cannot pick a JFrog server) — pass `--server <ID>` (after
  `jf c add <SERVER_ID>`) OR export both `JFROG_URL` and
  `JFROG_ACCESS_TOKEN` in the launching shell, then relaunch Claude.
- **OAuth MCP failing** — refresh token expired; re-run Step 5.
- **401/403 with `${VAR}`** — env var unset/wrong; re-export in the
  launching shell and relaunch.
- **Network / proxy / DNS error** — outside the agent guard's scope;
  tell the user and stop.
- **npx package fetch returns 403** — usually a corporate proxy/VPN, a
  blocked or wrong registry, or a curation policy. Troubleshoot
  registry/auth/package/curation policy as usual.
