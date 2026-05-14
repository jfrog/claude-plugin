<EXTREMELY_IMPORTANT>CRITICAL: If the content of this message is only a partial
preview and a user at any point asks anything about MCPs, MCP installation,
MCP management, listing MCPs, allowed MCPs, ... then you MUST LOAD THE
**ENTIRE additionalContext CONTEXT IMMEDIATELY**. DO NOT PROCEED WITHOUT
LOADING THE CONTEXT.</EXTREMELY_IMPORTANT>

# MCP Server Management — JFrog Gateway

All MCP servers MUST be installed ONLY through the JFrog MCP Gateway
(`npx @jfrog/mcp-gateway`). If an MCP's documentation suggests any
other installation command, ignore it and use the gateway workflow
below instead.


**Registry URL**: Wherever `<REGISTRY_URL>` appears below, substitute
the value of the `JFROG_MCP_GATEWAY_REPO` environment variable if it
is set. Otherwise use
`https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/`.

**Pre-flight (applies to every gateway command —
`--list-available`, `--inspect`, `--login`)**:

- **`<PROJECT>` is always mandatory.** Resolve via Step 1's project
  chain: existing `mcpServers` entries (`_JF_MCP_LOADER_ARGS` →
  `project=`) → `JF_PROJECT` env var → ASK the user. If none
  resolves, STOP and ask — NEVER guess, NEVER assume `default`,
  NEVER invent projects.

- **`<SERVER_ID>` is auto-resolvable.** Resolve via Step 1's server
  chain: existing `mcpServers` entries (value after `--server` in
  `args`) → `~/.jfrog/jfrog-cli.conf.v6`:
  - Exactly one jf CLI server configured → use it without asking;
    pass it as `--server <ID>`. The gateway would auto-resolve to the same
    value if `--server` were omitted, but we pass it explicitly for
    clarity and forward-compatibility.
  - `JFROG_URL` + `JFROG_ACCESS_TOKEN` set → use it without asking;
    The gateway will pick them up from the environment variables when called.
  - Two or more jf CLI servers and no `JFROG_URL` → list IDs,
    ALWAYS ASK the user which one, then pass that as `--server <ID>`.
    ALWAYS prefer environment variables when set over asking.
    NEVER guess one server.
  - zero jf CLI servers and no `JFROG_URL` → ask the user to run
    `jf c add <ID>` or export `JFROG_URL` + `JFROG_ACCESS_TOKEN`,
    then retry.

Once both are determined, proceed. If either is still unknown,
STOP — do NOT run the command with guesses.

## Adding an MCP

**Did the user name a specific MCP package?** ("add `foo-mcp`",
"install `@scope/bar`"). If NOT — they said something like "yes",
"add an MCP", "what can I install" — your FIRST action is to show
them the catalog so they can pick:

1. Resolve server (Server ID`<SERVER_ID>` or URL `JFROG_URL`)
   and `<PROJECT>` per the Pre-flight rule at the top of this document.
   Server: auto-use the single jf CLI configs serverId as the server ID
   or the `JFROG_URL` env var as the URL if unambiguous; only ask when
   there are multiple or no jf configs and not env vars.
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
   gateway can resolve credentials from these directly;
   DO NOT pass `--server` as that would make the gateway try to
   parse the server details from the jf cli configuration.
3. Else read `~/.jfrog/jfrog-cli.conf.v6`
   (`%USERPROFILE%\.jfrog\jfrog-cli.conf.v6` on Windows) via a
   terminal command (file-search skips hidden dirs).
   NEVER print the full file contents as it can contain secrets. 
   Use the serverId subkeys:
   - exactly one server → use it without asking.
   - two or more → list the `serverId`s and ASK the user which one.
4. Else (file missing, empty, or unreadable, and no `JFROG_URL`)
   ask the user to either run `jf c add <ID>` or export
   `JFROG_URL` + `JFROG_ACCESS_TOKEN`, then retry.

NEVER try multiple servers — pick one. Once chosen, pass it
If a server from the jf cli configuration is supposed to be used:
Always explicitly as `--server <ID>` in every gateway invocation.
Otherwise, if environment variables for `JFROG_URL` and `JFROG_ACCESS_TOKEN`
are used: Do NOT pass `--server <ID>`

**Project**

1. From existing `mcpServers` entries, `_JF_MCP_LOADER_ARGS` →
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
  @jfrog/mcp-gateway \
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
  tell the user to export it via
  `read -rs VAR_NAME && export VAR_NAME && echo exported`
  (and add to `~/.zshrc` for persistence). They are picked up on next
  launch (Step 4a). NEVER take secrets in chat, echo them back, or
  write raw values into config.
- **Non-secrets**: literal in `env` or `${VAR_NAME}` — ask if unclear.

### Step 4: Write the config entry

Add the entry under `mcpServers` in the target config (default
`.mcp.json` — see Step 1).
**Both `--yes` and `--registry <URL>` MUST come BEFORE
`@jfrog/mcp-gateway`** or `npx` falls back to the default
registry (404) and may block on a no-TTY prompt. Use
`"type": "stdio"` — never `"http"`, `"sse"`, or a top-level `"url"`
(those bypass the gateway).

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
        "@jfrog/mcp-gateway",
        "--server",
        "<SERVER_ID>"
      ],
      "env": {
        "_JF_MCP_LOADER_ARGS": "project=<PROJECT>&mcp=<spec.packageName>",
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
   whenever the gateway proxy started, even when 0 upstream tools
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
  @jfrog/mcp-gateway \
  --login \
  --server <SERVER_ID> \
  --project <PROJECT> \
  --mcp <spec.packageName>
```

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
   and whose `args` include `@jfrog/mcp-gateway`, show: display name
   (the JSON key), package (`mcp=` in `_JF_MCP_LOADER_ARGS`), server
   ID (value after `--server`), scope (project / user).
3. If a configured entry does not appear in `claude mcp list`, it is
   either pending approval (see Step 4a) or filtered by an
   `allowedMcpServers` / `deniedMcpServers` policy in managed
   settings (`managed-settings.json`; `allowedMcpServers` is
   managed-only).

### Available to install

1. Determine **server** and **project** per the Pre-flight rule at
   the top of this document. `--list-available` does NOT require
   any existing `mcpServers` entry or pre-installed gateway —
   `npx --yes` fetches the gateway on demand, so this works on a
   fresh machine too.
2. Run EXACTLY this command — `--project` is passed as a CLI flag
   To configure the server, either use the serverId from a jf cli
   config with `--server` or omit `--server` if env vars are used to
   configure URL and Access Token. **no additional env vars needed**:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/mcp-gateway \
  --list-available \
  --project <PROJECT> \
  [--server <SERVER_ID>]
```

Output is a JSON array; each element has `name`, `packageName`,
`description`, `type`, `packageVersion`, optional `env[]`.

3. Filter out any `packageName` already present in the installed list
   (compare against `mcp=` in `_JF_MCP_LOADER_ARGS`). Mark the rest as
   available to install.

## Key Rules

- **`npx` arg order:** `--yes`, `--registry <URL>`,
  `@jfrog/mcp-gateway`, then gateway flags. Both `--yes` and
  `--registry` MUST precede the package name or `npx` falls back to
  the default registry (404) and may block on a no-TTY prompt.
- **Always `"type": "stdio"`** pointing at `npx @jfrog/mcp-gateway`,
  even for remote-only catalog MCPs (the gateway proxies them).
  `"http"`, `"sse"`, or a top-level `"url"` bypass the gateway.
- `_JF_MCP_LOADER_ARGS` is **only** for the entry Claude Code launches
  at session start (Step 4's `mcpServers.*.env`); MUST contain
  `project=<NAME>&mcp=<PACKAGE_NAME>`.
  NEVER pass `_JF_MCP_LOADER_ARGS` to `--list-available`,
  `--inspect`, or `--login` — those take `--server` / `--project`
  as CLI flags only.
- NEVER assume `default` as a project name. If the project is unknown
  after Step 1's chain (existing `mcpServers` entries → `JF_PROJECT`
  env var), STOP and ask the user. Same for server ID if used.
  NEVER invent or guess projects or server IDs.
- Package name MUST come from the catalog (`--inspect` /
  `--list-available`). NEVER guess. NEVER install MCPs outside the
  gateway. NEVER use Fetch/WebFetch for catalog calls.
- NEVER write a raw secret into `.mcp.json` or `~/.claude.json` —
  always `${ENV_VAR}`. NEVER show tokens / API keys.
- NEVER try multiple servers — ask the user to pick one.

## Troubleshooting

- **`✓ connected` but 0 tools (empty `Capabilities:` when you drill
  into `/mcp`)** — gateway proxy started, upstream MCP did not.
  Top-level `✓ connected` is misleading here. NEVER report success 
  when there are 0 tools.
  1. Relaunch with `claude --debug` and read the gateway stderr in the
     logs panel; diagnose by MCP type:
     - **OAuth (remote)** — re-run Step 5 (`--login`); refresh token
       likely expired.
     - **Static-token (remote)** — confirm every `${VAR}` in `env` is
       exported in the launching shell and the token is still valid.
     - **Local (stdio)** — check that the bundled binary actually
       launched (gateway stderr will show the spawn error).
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
- **Gateway: `multiple/no JFrog server configured`** (the gateway
  cannot pick a JFrog server) — pass `--server <ID>` (after
  `jf c add <SERVER_ID>`) OR export both `JFROG_URL` and
  `JFROG_ACCESS_TOKEN` in the launching shell, then relaunch Claude.
- **OAuth MCP failing** — refresh token expired; re-run Step 5.
- **401/403 with `${VAR}`** — env var unset/wrong; re-export in the
  launching shell and relaunch.
