# jfrog-mcp-shared

Shared reference content for the `jfrog-mcp-install`, `jfrog-mcp-list`, and
`jfrog-mcp-remove` skills. This directory is **not an invocable skill** — it has
no `SKILL.md` and is referenced by those skills via relative links. (All three
share `agent-guard-activation.md` and `runtime-permissions.md`; Install and List
additionally share the agent guard pre-flight and key-rules references — see
*Why shared* below.)

## References

- [`references/agent-guard-activation.md`](references/agent-guard-activation.md)
  — the Step 0 exit-code contract (0 enabled / 2 registry disabled → admin-IT
  message / other → silent abort) and the disabled-state exceptions. Referenced
  by all three skills' Step 0.
- [`references/agent-guard-common.md`](references/agent-guard-common.md) — `<REGISTRY_URL>`
  substitution and the pre-flight rules for resolving `<JFROG_PROJECT_KEY>` and
  `<SERVER_ID>` before running any `npx @jfrog/agent-guard` command.
- [`references/key-rules-and-troubleshooting.md`](references/key-rules-and-troubleshooting.md)
  — `npx` arg order, `stdio`/`_JF_ARGS` rules, secret handling, and agent guard
  troubleshooting (including "`✓ connected` but 0 tools").
- [`references/runtime-permissions.md`](references/runtime-permissions.md) — the
  network / `~/.jfrog/`-write permission matrix for Claude Code and the Node.js
  18+ requirement. Referenced by all three skills' Prerequisites.

## Why shared

The Install and List skills both invoke the agent guard and need the same
pre-flight resolution and rules, so they reference all the agent guard files.
Removal does not invoke the agent guard, so the `jfrog-mcp-remove` skill uses
only `agent-guard-activation.md` (its Step 0) and `runtime-permissions.md` (Step
0 + `~/.jfrog/` cleanup), not the agent guard pre-flight or key-rules
references.
