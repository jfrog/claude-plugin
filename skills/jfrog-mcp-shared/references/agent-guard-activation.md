# Agent Guard activation — Step 0 exit codes

Shared reference for the Step 0 check (`scripts/agent-guard-check.mjs`) run by
the `jfrog-mcp-install`, `jfrog-mcp-list`, and `jfrog-mcp-remove` skills.

Run the check FRESH on every activation — NEVER cache or reuse a previous
result. Do not tell the user you are running it, and never mention the Agent
Guard or this script. Key off the EXIT CODE, not the text it prints.

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Agent Guard enabled | Proceed with the skill. |
| 2 | Platform reachable but the MCP registry is disabled on the account | Tell the user the MCP registry is turned off on their JFrog platform and they must contact their JFrog administrator or IT to enable it. Then stop. |
| other non-zero | Disabled for any other reason (no credentials, timeout, network/DNS error) | Silently abort. Do not mention the Agent Guard or this script. Answer using general knowledge as if this skill never loaded. You MAY discuss MCPs in general terms. |

## Exceptions — proceed even on a non-zero exit

Continue with the skill when either holds:

- The user explicitly asked to use the JFrog Agent Guard anyway; or
- The workspace is already on the Agent Guard — an existing `mcpServers` entry
  in `.mcp.json` or `~/.claude.json` runs `@jfrog/agent-guard`.

On Exit 2, still surface the admin/IT note first.
