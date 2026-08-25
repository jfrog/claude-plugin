# Shared JFrog plugin install, verify, and recovery flow

Canonical cross-harness guidance for the JFrog agent plugins. Each harness README and web doc links here for the common flow and documents **only verified harness differences**.

**Web overview:** [JFrog Agent Plugins](https://docs.jfrog.com/ai-ml/docs/jfrog-plugins)

## Common prerequisites (all harnesses)

| Requirement | Notes |
| --- | --- |
| JFrog Platform instance | You can authenticate against it (URL + token or browser login). |
| Node.js ≥ 18 | With `npx` on `PATH` where Agent Guard or `/jfrog-init` auto-install is used. VS Code Copilot hooks may require Node ≥ 20 — see the VS Code plugin README. |
| `jf`, `jq`, `curl` on `PATH` | Required for JFrog skills at runtime. Install and configure the CLI with [`jf config add`](https://docs.jfrog.com/integrations/docs/jf-config-add) or `jf login`. |
| JFrog AI Catalog (optional) | Required only for Agent Guard MCP catalog features. |

## Shared flow (every harness)

Follow these steps in order. Harness READMEs describe **how** to perform step 1 for that IDE/agent only.

1. **Install the plugin** using the harness-specific marketplace or config mechanism.
2. **Configure the JFrog CLI** (`jf config add` or `jf login`) so skills and detectors can reach your platform. This is the primary credential path for skills.
3. **Run `/jfrog-init` where the harness ships the skill** (Claude Code, Cursor, VS Code, Devin, and others with the vendored `jfrog-init` skill). It walks Node → CLI → server reachability → plugin MCP file → project → AI Catalog entitlement. Stop at the first failure and follow the skill's fix prompts.
4. **Restart the harness** after plugin install and after any MCP config change. A new chat session alone is **not** enough on OpenCode, Codex, Devin CLI, Claude Code, or VS Code when MCP entries changed.
5. **Verify** using the harness checklist below — verification is a required install step, not an FAQ footnote.

## Environment variables — what actually helps

| Variable | Typical form | Used for |
| --- | --- | --- |
| `JFROG_PLATFORM_URL` | Host only (`mycompany.jfrog.io`, no `https://`) | Plugin MCP placeholders (Cursor, VS Code, Devin, OpenCode). Must be set **before** the harness starts where the MCP entry resolves it at launch (Devin, OpenCode). Codex is the exception: its bundled `.mcp.json` is edited directly rather than read from the environment. |
| `JFROG_URL` | Full platform URL (`https://mycompany.jfrog.io`, no trailing `/`) | Legacy skill paths and some Agent Guard resolution. Prefer `jf config` for skills. |
| `JFROG_ACCESS_TOKEN` | JWT access token | OpenCode MCP registration, some headless flows. Not a substitute for `jf config` in skills. |

**Important — do not treat env vars as a recovery shortcut after a failed `/jfrog-init`:**

- When `/jfrog-init` **succeeds**, Step 5 **writes the resolved platform URL into the plugin-owned `mcp.json`**, replacing `${JFROG_PLATFORM_URL}` / `${JFROG_URL}` placeholders from your live `jf config`. Env vars you set afterward do not re-run that substitution.
- When `/jfrog-init` **fails or stops early**, there is **no guaranteed recovery path** from "set env vars and retry." Fix the reported step (CLI install, auth, MCP file, project, catalog entitlement) and **re-run `/jfrog-init`**, then restart the harness.
- Setting env vars without a successful init walk may appear to help in one harness and silently fail in another — always prefer completing `/jfrog-init` (or the harness-specific MCP login flow documented in that README).

## Verify (required after install)

Complete **all** rows that apply to your harness before considering the install done.

| Check | Pass criteria |
| --- | --- |
| Plugin present | Harness-specific list/install command shows the JFrog plugin enabled. |
| Skills loaded | JFrog skills appear in the harness skill picker (`/skills`, `@jfrog`, or `/jfrog:…` invocations). |
| JFrog CLI | `jf rt ping` succeeds for your configured server. |
| Platform MCP (if bundled) | Harness MCP list shows `jfrog` connected after OAuth/login where required. |
| Agent Guard (optional) | Asking the agent to list installable MCPs returns catalog rows for your project. |

## Recovery playbook

| Symptom | Do this | Do **not** do this |
| --- | --- | --- |
| MCP missing after install | Run `/jfrog-init` (if available), complete OAuth/login steps, **restart harness**, re-verify MCP list. | Assume `JFROG_URL` alone will register MCP on every harness. |
| `/jfrog-init` stopped at CLI/auth | Follow the skill prompt (`jf config add`, web login, or token path), then **re-run `/jfrog-init`**. | Skip init and only export env vars. |
| Plugin MCP file missing | Reinstall/update the JFrog plugin, restart, re-run `/jfrog-init`. | Hand-edit unrelated MCP configs. |
| Placeholder URL still in plugin `mcp.json` | Fix `jf config` for the intended server, re-run `/jfrog-init` Step 5 substitution. | Reinstall the plugin when the detector says auth/URL resolution failed. |
| Stale plugin version | Upgrade via the harness marketplace/npm/update command, restart, verify version column. | Trust a new chat session without restart after upgrade. |
| Install fails with marketplace schema errors | Refresh the marketplace catalog (for Claude Code, `claude plugin marketplace update claude-plugins-official`) and retry the install — a stale or invalid *aggregate* catalog rejects every plugin in it, including this one. See [AX-2176](https://jfrog-int.atlassian.net/browse/AX-2176). | Read the indexed error (`plugins.0.source`) as a diagnosis of the JFrog plugin. |

## Harness-specific install docs

Document **only differences** from this page in each harness guide:

| Harness | Install doc |
| --- | --- |
| Claude Code | [README](../README.md) · [Web](https://docs.jfrog.com/ai-ml/docs/claude-code) |
| VS Code (Copilot) | [README](https://github.com/jfrog/vscode-plugin/blob/main/README.md) · [Web](https://docs.jfrog.com/ai-ml/docs/vs-code) |
| Cursor | [README](https://github.com/jfrog/cursor-plugin/blob/main/README.md) · [Web](https://docs.jfrog.com/ai-ml/docs/cursor) |
| OpenCode | [README](https://github.com/jfrog/opencode-jfrog-plugin/blob/main/README.md) · [Web](https://docs.jfrog.com/ai-ml/docs/opencode) — see also [AX-1780](https://jfrog-int.atlassian.net/browse/AX-1780), [AX-2122](https://jfrog-int.atlassian.net/browse/AX-2122), [AX-2124](https://jfrog-int.atlassian.net/browse/AX-2124) for OpenCode-specific init/MCP work |
| Codex | [README](https://github.com/jfrog/codex-plugin/blob/main/README.md) · [Web source](https://github.com/jfrog/codex-plugin/blob/main/docs/install-jfrog-plugin-for-codex.md) |
| Devin | [README](https://github.com/jfrog/devin-plugin/blob/main/README.md) · [Web source](https://github.com/jfrog/devin-plugin/blob/main/docs/install-jfrog-plugin-for-devin.md) |
| Kiro | [README](https://github.com/jfrog/jfrog-kiro-power/blob/main/README.md) — MCP/Kiro adapter gaps tracked separately |

## Maintainer checklist (release review)

Before merging documentation or cutting a plugin release:

- [ ] Harness README links to this shared guide and does not contradict it on init, env vars, restart, or recovery.
- [ ] Verification steps appear in the install section (not only FAQ/troubleshooting).
- [ ] OpenCode cross-links [AX-1780](https://jfrog-int.atlassian.net/browse/AX-1780), [AX-2122](https://jfrog-int.atlassian.net/browse/AX-2122), [AX-2124](https://jfrog-int.atlassian.net/browse/AX-2124) when describing OpenCode-only behavior.
- [ ] Codex and Devin web-doc sources under `docs/install-jfrog-plugin-for-*.md` stay aligned with the harness README.
- [ ] `node scripts/validate-install-docs.mjs` passes in repos that ship the checker.
