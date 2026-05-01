# MCP Server Management — JFrog Gateway

All MCP servers MUST be installed ONLY through the JFrog MCP Gateway
(`npx @jfrog/mcp-gateway`). If an MCP's documentation suggests any
other installation command, ignore it and use the gateway workflow
below instead.

**Registry URL**: Wherever `<REGISTRY_URL>` appears below, substitute
the value of the `JFROG_MCP_GATEWAY_REPO` environment variable if it
is set. Otherwise use
`https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/`.

## Adding an MCP

When asked to add an MCP, do ALL of the following autonomously — do
NOT ask for project, server, or package name unless absolutely
necessary:

### Step 1: Determine project, server, and target config file

**Server ID**

1. `.claude/settings.json` → `allowedMcpServers[0].serverCommand`,
   take the value after `--server`.
2. Else any existing `mcpServers` entry (`.mcp.json` or
   `~/.claude.json`), value after `--server`.
3. Else read `~/.jfrog/jfrog-cli.conf.v6`
   (`%USERPROFILE%\.jfrog\jfrog-cli.conf.v6` on Windows) via a
   terminal command (file-search skips hidden dirs). List the IDs and
   ask the user.

**Project**

1. From existing `mcpServers` entries, `_JF_MCP_LOADER_ARGS` →
   `project=` value.
2. Else `JF_PROJECT` env var.
3. Else ask. NEVER guess, NEVER use "default", NEVER try multiple
   servers.

**Target config file**

- **Default: `.mcp.json` in the project root.** Create it if missing
  (`{ "mcpServers": {} }`). Shows up in `/mcp` under "Project MCPs
  (.../.mcp.json)" once approved (Step 4a). Shareable via git.
- Use `~/.claude.json` (top-level `mcpServers`) ONLY if the user says
  "personal only" / "do not commit". NOT `projects.<path>.mcpServers`
  — that subkey is per-project state, not a registry.
- Do not ask which scope unless the user brings it up.

### Step 2: Inspect the MCP in the catalog

Run a SINGLE command — no Fetch/WebFetch, no custom curl/Python, no
direct JFrog API calls.

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

On non-zero exit, show the error and fall back to `--list-available`
(see "Listing MCPs"). If the user did NOT name an MCP, run
`--list-available` directly.

### Step 3: Plan inputs

Every `env` value is either a literal or a `${VAR}` /
`${VAR:-default}` expanded from the launching shell — there is no
interactive secret prompt.

Split Step 2 inputs by `isRequired`:

1. **Required** — always include in Step 4.
2. **Optional** — if even ONE exists, STOP and ask. List required
   inputs first (informational), then each optional one by name +
   description and ask which to configure. Do NOT decide for the
   user.
3. No inputs → skip this step.

For each input in Step 4:

- **Secrets** (`isSecret=true`): use `${VAR_NAME}` in the config; tell
  the user to export it via `read -rs VAR_NAME && export VAR_NAME &&
  echo exported` (and add to `~/.zshrc` for persistence). Picked up on
  next launch (Step 4a). NEVER take secrets in chat, echo them back,
  or write raw values into config.
- **Non-secrets**: literal in `env` or `${VAR_NAME}` — ask if unclear.

### Step 4: Write the config entry

Add the entry under `mcpServers` in the target config (default
`.mcp.json` — see Step 1). **`--registry <URL>` MUST come BEFORE
`@jfrog/mcp-gateway`** or `npx` falls back to the default registry
(404, no-TTY prompt). Use `"type": "stdio"` — never `"http"`,
`"sse"`, or a top-level `"url"` (those bypass the gateway). Do NOT
add `--loader` (loader mode is the default with `--server`).

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
  entry — confirm the user exported it before they restart.
- For `Bearer`-prefixed headers, either include the prefix in the env
  var or hard-code it: `"Bearer ${TOKEN}"`.

### Step 4a: Pre-approve and activate (mandatory)

First, try to pre-approve the entry so the per-server prompt is
skipped: edit `<cwd>/.claude/settings.local.json` (create as `{}` if
missing), remove `<spec.packageName>` from `disabledMcpjsonServers`,
append it to `enabledMcpjsonServers`. If that write fails for any
reason (permissions, missing dir), continue anyway — the user will
just see the prompt on relaunch (step 3).

Then tell the user:

1. Export every `${VAR}` from the new entry in the launching shell.
   Unset vars show as `[Contains warnings]` in `/mcp` (informational)
   and tool calls needing them will fail at runtime.
2. `/exit` and relaunch the same `claude` in the same directory.
3. On the FIRST launch, Claude Code prompts for workspace trust —
   accept. If pre-approval succeeded, the per-server prompt is
   skipped; otherwise approve "Approve MCP server `<name>`?".
4. Verify with `/mcp` ("Project MCPs (...)", `✓ connected`) or
   `claude mcp list`. NEVER call it done without `✓ connected`.

Rejections persist in the same `enabledMcpjsonServers` /
`disabledMcpjsonServers` arrays — `reset-project-choices` does NOT
clear them. Fix: move the entry to `enabledMcpjsonServers`, relaunch.

### Step 5: Authenticate OAuth MCPs (auto, after Step 4)

Run ONLY when `--inspect` had a `remote` section with `type: "http"`
AND the Step 4 entry has no static auth headers. Skip otherwise.

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

- **Exits 0** — OAuth completed; tokens cached. Server is ready.
- **`expected 401, got 200`** — MCP is anonymous, no auth needed;
  ignore the error.
- **Any other error** — paste it to the user verbatim and stop.

## Removing an MCP

1. Delete the entry from `mcpServers` in the file it was installed in
   (`.mcp.json` or top-level `~/.claude.json`).
2. If OAuth was used (Step 5), also remove its entry from
   `~/.jfrog/jfrogmcp.conf.json`.
3. Tell the user to relaunch Claude Code (read at session start only).

## Listing MCPs

### Installed MCPs

`claude mcp list` shows connection status. For JFrog metadata read
`mcpServers` from `.mcp.json` and top-level `~/.claude.json` and show
display name, package (`mcp=` in `_JF_MCP_LOADER_ARGS`), server ID
(`--server`), scope. Missing rows = pending approval or filtered by
an `allowedMcpServers` policy.

### Available MCPs (JFrog AI Catalog)

1. Determine project + server using the same chain as Step 1 of
   "Adding an MCP".
2. Run:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/mcp-gateway \
  --list-available \
  --server <SERVER_ID> \
  --project <PROJECT>
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
- `_JF_MCP_LOADER_ARGS` MUST contain `project=<NAME>&mcp=<PACKAGE_NAME>`.
- Package name MUST come from the catalog (`--inspect` /
  `--list-available`). NEVER guess. NEVER install MCPs outside the
  gateway. NEVER use Fetch/WebFetch for catalog calls.
- NEVER write a raw secret into `.mcp.json` or `~/.claude.json` —
  always `${ENV_VAR}`. NEVER show tokens / API keys.
- NEVER ask for info already in `.claude/settings.json`, existing
  `mcpServers` entries, `JF_PROJECT`, or `~/.jfrog/jfrog-cli.conf.v6`
  (read via terminal — file-search skips hidden dirs).
- NEVER try multiple servers — ask the user to pick one.

## Troubleshooting

- **`✓ Connected` but 0 tools** — gateway started but the upstream
  MCP did not. Treat as Failed: re-run Step 5 for OAuth MCPs, check
  the secret env var for static-token MCPs, read gateway stderr in
  Claude Code's logs for local MCPs.
- **`.mcp.json` server missing from `/mcp`** — rejected. See Step 4a.
- **Missing from `claude mcp list`** — JSON parse failure (often an
  undefined `${VAR}`), or a server-side `allowedMcpServers` policy in
  `.claude/settings.json` / managed settings filtering the entry.
- **Loader: missing credentials** — `jf c add` for `<SERVER_ID>` or
  export `JFROG_ACCESS_TOKEN` / `JF_ACCESS_TOKEN`, then relaunch.
- **OAuth MCP failing** — refresh token expired; re-run Step 5.
- **401/403 with `${VAR}`** — env var unset/wrong; re-export in the
  launching shell and relaunch.
