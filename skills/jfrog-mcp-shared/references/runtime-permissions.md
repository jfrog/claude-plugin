# Runtime permissions

The Step 0 Agent Guard check and the agent guard commands make outbound HTTPS
calls, and some operations also write under `~/.jfrog/`. Grant the matching
runtime permission, or the commands fail (`Forbidden`, empty output) or the
Step 0 check returns a false "disabled" result.

| Operation                       | Claude Code permission                                   |
| ------------------------------- | -------------------------------------------------------- |
| Network                         | `allowed-tools: Bash(node *) Bash(npx *)` + host allowlist |
| Network + `~/.jfrog/` write     | same + filesystem allowlist for `~/.jfrog/`              |

- **Network** covers: the Step 0 check (`agent-guard-check.mjs`), `--inspect`,
  and `--list-available`.
- **Network + `~/.jfrog/` write** covers operations that also persist or remove
  tokens under `~/.jfrog/` — OAuth `--login` (writes
  `~/.jfrog/jfrogmcp.conf.json`) and removing that cached entry.

Also required: **Node.js 18+** on `PATH` — the Step 0 check uses the built-in
`fetch`.
