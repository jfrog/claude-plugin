---
name: jfrog-setup-package-managers
description: >-
  Use this skill when the user asks to set up, configure, bind, or connect a
  package manager (npm, pip, maven, gradle, go, docker, helm, …) to JFrog
  Artifactory via `jf setup` and `.jfrog/local/package-guard.json`; when a
  workspace manifest exists with no matching marker entry; or when a session
  hook reports PM config missing. Skip when the marker already has the same
  repo key — the session hook reapplies each start. Do NOT discover or
  enumerate repositories; use resolver output only. On unresolved or failed
  setup, ask for a repo key with the failure verbatim — never switch servers.
metadata:
  role: workflow
---

# JFrog — Setup Package Managers for Artifactory

Agent-driven half of `package-guard`: apply the session hook's repo pick
via [`jf setup`](references/jf-setup-command.md), then record it in
[`.jfrog/local/package-guard.json`](references/package-guard-config.md).
`jf setup` writes PM-native config (`.npmrc`, `pip.conf`, …); the marker
lets the hook re-apply on later sessions.

## Scope (this skill vs session hook)

The **session-start hook** (package-guard) picks repo keys per package
type, applies workspace overrides, injects the **"Resolved URLs for this
session"** table, and refreshes the global cache. Do **not** resolve,
list, or probe repositories.

**This skill** only:

1. **Reads** repo keys — session table → workspace marker → global cache
   (Step 2; details in [`cache-file.md`](references/cache-file.md)).
2. **Runs** `jf setup <pm> --server-id … --repo …` to write PM config.
3. **Persists** the workspace choice in `.jfrog/local/package-guard.json`.

Later sessions re-apply via the hook automatically — no agent action needed.

## Prerequisites

- Read [`../jfrog/SKILL.md`](../jfrog/SKILL.md) for CLI install, server config,
  and user-agent rules. Needs `jf` + a configured server (`<SID>`). If the
  hook reports `jf-not-installed` / `jf-not-configured`, start at Step 0.
- `jf setup` **mutates user state** (`~/.npmrc`, `~/.docker/config.json`, …).
  Confirm before the first `jf setup` in a session unless the user explicitly
  requests silent/non-interactive setup.

**Out of scope:** CLI install/login (`../jfrog/references/…`); repo listing
or discovery (`jf api /artifactory/api/repositories`).

## Gotchas

- **Always pass `--repo` and `--server-id`** — omitting `--repo` fails when
  multiple repos match. See [`jf-setup-command.md`](references/jf-setup-command.md).
- **`jf setup` overwrites PM config** without backup — skip PMs whose marker
  already matches (Step 1, signal 2).
- **Docker / Podman — prefix or stop.** `jf setup docker` writes creds only;
  bare `docker pull <img>` hits Docker Hub. Complete setup, then pull via
  `<host>/<repoKey>/<img>`.
- **Marker holds decisions, not credentials** — never write tokens into
  `.jfrog/local/package-guard.json`.

## References

| File | When to read |
|------|--------------|
| [`references/jf-setup-command.md`](references/jf-setup-command.md) | CLI flags, supported PMs, exit-code contract, `jf setup --help` |
| [`references/cache-file.md`](references/cache-file.md) | Global cache shape, resolution classes, jq one-liners |
| [`references/package-guard-config.md`](references/package-guard-config.md) | Workspace marker schema, PM → type map, merge semantics |

## Step 0 — Ensure `jf` is installed and a server is configured

Recovery when routing is enforced but not ready. Skip if `jf config show` succeeds.

1. **`jf --version`** — missing → install per
   [`../jfrog/references/jfrog-cli-install-upgrade.md`](../jfrog/references/jfrog-cli-install-upgrade.md).
2. **`jf config show`** — empty → login per
   [`../jfrog/references/jfrog-login-flow.md`](../jfrog/references/jfrog-login-flow.md)
   or `jf config add` with access-token (Bearer-only).
3. Do not run `jf setup` until both succeed. Confirm before install/login.

## Step 1 — Identify package managers to bind

Combine four signals, in order; intersect with `jf setup --help` supported list:

1. **Explicit user mention.** Map aliases: python → `pip`/`poetry`; java →
   `maven`/`gradle`; node → `npm`/`yarn`/`pnpm` by lockfile.
2. **Workspace marker** — read `.jfrog/local/package-guard.json`. Drop PMs
   already bound to the same key unless recovering from 401/403 (re-run same
   key). PM → type table: [`package-guard-config.md`](references/package-guard-config.md).
3. **Workspace manifests** when still ambiguous:

   | Manifest file | Package manager |
   |---|---|
   | `package.json`, `pnpm-lock.yaml`, `yarn.lock` | `npm` (+ `yarn`/`pnpm` if lockfiles present) |
   | `requirements.txt`, `Pipfile` | `pip` (`pipenv` for `Pipfile`) |
   | `pyproject.toml` | `poetry` if `[tool.poetry]`; else `pip` |
   | `pom.xml` | `maven` |
   | `build.gradle`, `build.gradle.kts` | `gradle` |
   | `go.mod` | `go` |
   | `Dockerfile`, `compose.yaml`, `docker-compose.yml` | `docker` / `podman` |
   | `*.csproj`, `NuGet.Config` | `nuget` / `dotnet` |
   | `Chart.yaml` | `helm` |

4. **`jf setup --help`** — filter candidates; never hardcode the PM list. See
   [`jf-setup-command.md`](references/jf-setup-command.md). Unsupported PM →
   report gap, skip.

## Step 2 — Get the resolved repo (don't re-resolve)

For each `<pm>`, recover `<repoKey>` and `<serverId>` from the first source
available — **no** list/discovery calls:

1. **"Resolved URLs for this session"** table (default). Parse `<repoKey>`
   from URL; `<serverId>` from host.
2. **Workspace marker** — if table was trimmed. `repositories.<type>`.
3. **Global cache** — last resort only; never overrides (1) or (2). See
   [`cache-file.md`](references/cache-file.md).

Cache disagreeing with (1)/(2) is not a reason to change the repo.

**Must not:** list repos; enumerate candidates; iterate `--server-id`; second-guess
the resolver.

### Unresolved repo key

Ask via AskQuestion — never enumerate:

> No default repo for `<pm>` on `<SID>`.
> Which Artifactory repository should I use? (repo key, or `abort`.)

Cap at **2 answers per PM**, then abort. User may override repo only, never server.

## Step 3 — Confirm, run `jf setup`, persist marker

1. Present the plan, one row per PM:

   ```text
   <pm>  → <repoKey> on <SID>               (source: resolver)
   <pm>  → <repoKey> on <SID>               (source: user-supplied)
   ```

2. Show marker diffs when the repo key changes.

3. **Confirm** via AskQuestion (`apply` / `change repos` / `abort`) unless the
   user explicitly requested silent/non-interactive setup — then run directly.

4. Sequentially, one PM at a time:

   ```bash
   jf setup <pm> --server-id <SID> --repo <repoKey> [--project <key>]
   ```

5. **Exit code `0` = success** — merge marker (step 6). On non-zero, **stop**,
   surface CLI output verbatim, offer alternate repo or `abort` (2-answer cap).

6. On success, merge into `.jfrog/local/package-guard.json` per
   [`package-guard-config.md`](references/package-guard-config.md):

   ```json
   { "repositories": { "<pkgType>": "<repoKey>" } }
   ```

   Map PM → type via the reference table. Merge atomically.
