# Agent Guard activation — Step 0 exit codes

Reference for the Step 0 check (`scripts/jfrog-agent-guard-check.mjs`) run by
the `jfrog-ai-catalog` skill before plugin catalog / download flows.

Run the check FRESH on every activation — NEVER cache or reuse a previous
result. Do not tell the user you are running it, and never mention the Agent
Guard or this script. Key off the EXIT CODE, not the text it prints.

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Agent Guard enabled | Proceed with the skill. |
| 2 | Platform reachable but the Agent Guard / AI Catalog is disabled on the account | **Discover plugins / Install or update a plugin / Publish a plugin:** tell the user the AI Catalog is turned off on their JFrog platform and they must contact their JFrog administrator or IT to enable it, then stop. **List installed plugins / Remove:** proceed — local only, no catalog (see SKILL.md). |
| other non-zero | Disabled for any other reason (no credentials, timeout, network/DNS error) | **Discover plugins / Install or update a plugin / Publish a plugin:** silently abort — do not mention the Agent Guard or this script; answer using general knowledge as if this skill never loaded (you MAY discuss plugins in general terms). **List installed plugins / Remove:** proceed — local only, no catalog or network (see SKILL.md). |

## Local-only flows proceed on every exit code

These flows are local reads/edits that do NOT require the catalog entitlement
gate — they proceed on Exit 0, Exit 2, and Exit 1 alike, and do not depend on
Step 0:

- **Remove a plugin** — delete the install directory (see
  [managing-installed-plugins.md](managing-installed-plugins.md)).
- **List currently installed plugins** — `jf agent plugins list` against local
  harness/global installs (without relying on catalog browse). Skip
  `--check-updates` when Step 0 is non-zero; that flag hits the registry.

Only **Discover plugins**, **Install / update a plugin**, and **Publish a
plugin** are gated on Exit 0 (they hit the catalog or registry over the
network); see the exception below.

## Exception — catalog / download flows may proceed on a non-zero exit

This exception applies ONLY to "other non-zero" exits (no credentials,
timeout, network/DNS error). It does NOT apply to Exit 2: the platform
explicitly reported the Agent Guard / AI Catalog is disabled, so no agent
guard or catalog download command can succeed — stop after telling the user to
contact their admin/IT.

Continue with the skill when the user explicitly asked to use the JFrog Agent
Guard / AI Catalog anyway.
