---
description: List MCP servers available to install from the JFrog catalog (via Agent Guard)
---

The user wants to list the MCP servers available to install from the JFrog
catalog. Load `${CLAUDE_PLUGIN_ROOT}/templates/jfrog-mcp-management.md` in full
and follow its **"Listing MCPs > Available to install"** workflow exactly.

Key points (see the template for the authoritative rules):

- **Live execution is mandatory.** RE-RUN the command every time — never reuse
  or re-display output from earlier in the chat.
- **Resolve `<REGISTRY_URL>`** from the `JFROG_AGENT_GUARD_REPO` env var if set,
  otherwise `https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/`.
- **Resolve `<PROJECT>`** (mandatory) via the pre-flight chain: existing
  `mcpServers` entries (`_JF_ARGS` → `project=`) → `JF_PROJECT` env var → ASK
  the user. NEVER guess, NEVER assume `default`.
- **Resolve `<SERVER_ID>`** (auto-resolvable): existing `mcpServers` `--server`
  → `JFROG_URL` + `JFROG_ACCESS_TOKEN` env (then omit `--server`) →
  `jf config show --format=json` (one server, or the `isDefault` one; ask if
  ambiguous). Pass `--server <ID>` only when resolved from a jf CLI config.

Then run EXACTLY this command once (do not pipe through `python3`/`jq`, do not
capture with `2>&1`):

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --list-available \
  --project <PROJECT> \
  [--server <SERVER_ID>]
```

The output is a compact TSV (`name<TAB>type<TAB>version<TAB>description`).
Present the rows directly as a numbered table. If it returns nothing or errors,
say so — do NOT pad the answer with MCP names from anywhere else.
