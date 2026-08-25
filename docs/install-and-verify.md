# Claude Code install, verify, and recovery

How to install, verify, and recover the JFrog plugin for Claude Code. This document covers Claude Code only.

**Web overview:** [Install JFrog Agent Plugin for Claude Code](https://docs.jfrog.com/ai-ml/docs/claude-code)

## Prerequisites

| Requirement | Notes |
| --- | --- |
| JFrog Platform instance | You can authenticate against it (URL + token or browser login). |
| Claude Code CLI (≥ 1.0) | Plugin commands (`claude plugin …`) must be available. |
| Node.js ≥ 18 | With `npx` on `PATH` (used by Agent Guard and `/jfrog-init`). |
| `jf`, `jq`, `curl` on `PATH` | Required for JFrog skills at runtime. Install and configure the CLI with [`jf config add`](https://docs.jfrog.com/integrations/docs/jf-config-add) or `jf login`. |
| JFrog AI Catalog (optional) | Required only for Agent Guard MCP catalog features. |

## Install flow

1. **Install the plugin** from Claude's official marketplace:

   ```bash
   claude plugin marketplace update claude-plugins-official
   claude plugin install jfrog@claude-plugins-official
   ```

2. **Configure the JFrog CLI** (`jf config add` or `jf login`) so skills and detectors can reach your platform. This is the primary credential path for skills.

3. **Run `/jfrog-init`.** It walks Node → CLI → server reachability → plugin MCP file → project → AI Catalog entitlement. Stop at the first failure and follow the skill's fix prompts.

4. **Restart Claude Code** after plugin install and after any MCP config change. A new chat session alone is not enough when MCP entries changed.

5. **Verify** using the checklist below — verification is a required install step, not an FAQ footnote.

## Environment variables

| Variable | Typical form | Used for |
| --- | --- | --- |
| `JFROG_URL` | Full platform URL (`https://mycompany.jfrog.io`, no trailing `/`) | Plugin MCP and some skill paths. Prefer `jf config` for skills. |
| `JFROG_ACCESS_TOKEN` | JWT access token | Some headless flows. Not a substitute for `jf config` in skills. |

**Do not treat env vars as a recovery shortcut after a failed `/jfrog-init`:**

- When `/jfrog-init` **succeeds**, it writes the resolved platform URL into the plugin-owned `mcp.json`, replacing placeholders from your live `jf config`. Env vars you set afterward do not re-run that substitution.
- When `/jfrog-init` **fails or stops early**, there is no guaranteed recovery path from "set env vars and retry." Fix the reported step (CLI install, auth, MCP file, project, catalog entitlement) and **re-run `/jfrog-init`**, then restart Claude Code.

## Verify (required after install)

Complete all rows before considering the install done.

| Check | Pass criteria |
| --- | --- |
| Plugin present | `/plugins` → **Installed** lists the JFrog plugin. |
| Initialization | `/jfrog-init` completes without blocking errors. Restart Claude Code if it changed MCP config. |
| JFrog CLI | `jf rt ping` succeeds for your configured server. |
| Platform MCP | JFrog MCP tools are available in the session after OAuth if prompted. |
| Agent Guard (optional) | Asking the agent to list installable MCPs returns catalog rows for your project. |

## Recovery playbook

| Symptom | Do this | Do **not** do this |
| --- | --- | --- |
| MCP missing after install | Run `/jfrog-init`, complete OAuth if prompted, **restart Claude Code**, re-check MCP tools. | Assume `JFROG_URL` alone will register MCP. |
| `/jfrog-init` stopped at CLI/auth | Follow the skill prompt (`jf config add`, web login, or token path), then **re-run `/jfrog-init`**. | Skip init and only export env vars. |
| Plugin MCP file missing | Reinstall/update the JFrog plugin, restart, re-run `/jfrog-init`. | Hand-edit unrelated MCP configs. |
| Placeholder URL still in plugin `mcp.json` | Fix `jf config` for the intended server, re-run `/jfrog-init` so it can substitute the URL. | Reinstall the plugin when the detector says auth/URL resolution failed. |
| Stale plugin version | Upgrade via the marketplace, restart, confirm the installed version. | Trust a new chat session without restart after upgrade. |
| Install fails with marketplace schema errors | Run `claude plugin marketplace update claude-plugins-official` and retry the install — a stale or invalid *aggregate* catalog rejects every plugin in it, including this one. | Read the indexed error (`plugins.0.source`) as a diagnosis of the JFrog plugin. |

## Maintainer checklist (release review)

Before merging documentation or cutting a plugin release:

- [ ] [`README.md`](../README.md) and this page agree on init, env vars, restart, verification, and recovery.
- [ ] Verification steps appear in the install section (not only FAQ/troubleshooting).
- [ ] This document does not send readers to another plugin repository for install or recovery steps.
