---
name: jfrog-mcp-remove
description: >-
  Remove, uninstall, delete, disconnect, wipe, or turn off an MCP server or
  tool that was added through the JFrog Agent Guard — e.g. "remove the Slack
  MCP", "delete the Slack config", even if the user doesn't say "MCP".
allowed-tools: Bash(node *agent-guard-check.mjs*), Read, Edit
---

# Remove an MCP

## Prerequisites

- **Node.js 18+** on `PATH` (Step 0 uses the built-in `fetch`).
- **Network access** for the Step 0 check.
- **`~/.jfrog/` write access** if the MCP used OAuth (removing its cached entry
  from `~/.jfrog/jfrogmcp.conf.json`).
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
On Exit 0 (or a listed exception) proceed to "Removing an MCP" below.

## Removing an MCP

1. **Locate the entry across both scopes first.** Read `mcpServers` from BOTH
   the project config (`.mcp.json` in the project root) and the user config
   (top-level `~/.claude.json`), and list every exact match by name with its
   scope. Then:
   - Exactly one match → delete that entry.
   - Present in both scopes (duplicate) → tell the user it exists in both and
     ask whether to remove both or just one before editing either file.
   - No match → say so; do not edit anything.
   Only after resolving scope, delete the entry from `mcpServers` in the
   matched file(s).
2. **OAuth cache — only after every matching entry is gone.** The
   `~/.jfrog/jfrogmcp.conf.json` cache is shared across scopes, so removing its
   key while a matching `mcpServers` entry still exists in another scope would
   break auth for that surviving install. So:
   - If no entry matched in step 1, skip this step entirely (do not touch the
     cache).
   - If a matching entry remains in the other scope (user kept only one of a
     duplicate), leave the cache key in place.
   - Only when all matching project and user entries have been deleted (or the
     user explicitly asks to clear cached credentials), read
     `~/.jfrog/jfrogmcp.conf.json`, delete the key under `servers` matching the
     MCP name, and write the file back. If the file or key is absent, skip
     silently.
3. Tell the user to relaunch Claude Code (`/exit`, then start `claude` again)
   so the removed entry stops loading (`mcpServers` is read at session start
   only).
