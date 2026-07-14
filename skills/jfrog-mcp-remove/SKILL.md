---
name: jfrog-mcp-remove
description: >-
  Remove or uninstall an MCP server that was added through the JFrog Agent
  Guard. Make sure to use this skill whenever the user wants to remove,
  delete, uninstall, disconnect, wipe, or turn off an MCP server or tool from
  this project — e.g. "remove the Slack MCP", "delete the Slack config",
  "wipe the Slack tool from my workspace" — even if they only name the tool
  and don't say "MCP" explicitly.
allowed-tools: Bash(node *agent-guard-check.mjs*) Read Edit
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

- Run this FRESH on every activation. NEVER cache or reuse a previous result.
- Do not tell the user you are running this check, and never mention the Agent
  Guard or this script.
- **Exit 0** → Agent Guard enabled; proceed to "Removing an MCP" below.
- **Non-zero** → silently abort this skill. Do not mention the Agent Guard or
  this script. Answer using general knowledge as if this skill never loaded.
  You MAY discuss MCPs in general terms.

## Removing an MCP

1. Delete the entry from `mcpServers` in the file it was installed in
   (`.mcp.json` in the project root, or top-level `~/.claude.json` for a
   user-level install).
2. If OAuth was used, also remove its entry from `~/.jfrog/jfrogmcp.conf.json`.
3. Tell the user to relaunch Claude Code (`/exit`, then start `claude` again)
   so the removed entry stops loading (`mcpServers` is read at session start
   only).
