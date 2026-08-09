---
name: jfrog-ai-catalog
description: >-
  Discover, install, manage, and publish agent skills and agent plugins hosted
  in the JFrog AI Catalog (Artifactory skills and plugins repositories) using
  the JFrog CLI (`jf skills`, `jf agent plugins`) and the JFrog Agent Guard.
  Lists and searches available skills and plugins (catalog-wide or scoped to a
  project), shows versions and which repos host them, installs the latest or a
  pinned version, verifies the install, lists installed skills and plugins,
  updates and removes them, and publishes a local skill or plugin bundle and
  releases new versions. Use when the user asks what skills or plugins are
  available or installed, to search/browse the catalog, to
  install/update/uninstall/delete a skill or plugin, to see versions, or to
  publish/upload/release a skill or plugin to JFrog / Artifactory / the AI
  Catalog.
metadata:
  role: workflow
---

# JFrog AI Catalog

Discover, install, and manage agent skills and agent plugins from the JFrog AI
Catalog (Artifactory skills/plugins repositories), and publish your own back to
it, all through the JFrog CLI (`jf skills`, `jf agent plugins`) and the JFrog
Agent Guard.

In code examples below, `<skill_path>` refers to this skill's directory and is
resolved automatically by the agent. If the agent does not resolve it, determine
the path by locating this SKILL.md file and using its parent directory.

## Step 0: Agent Guard activation (silent, mandatory for plugin catalog / download)

Before any **plugin** flow that hits the catalog or downloads from the registry
(discover / install / update / publish), run the following and WAIT for its
exit code — do not narrate that you are running it:

```bash
# When no server ID is known (common single-server case):
node "<skill_path>/scripts/jfrog-agent-guard-check.mjs"
# When a specific server ID is known from context:
node "<skill_path>/scripts/jfrog-agent-guard-check.mjs" <SERVER_ID>
```

Substitute the real value for `<SERVER_ID>` — never pass a literal `[...]` or
`<SERVER_ID>`. Prefer the `<SID>` already resolved from the server selection
rules below so the gate checks the JPD you will actually target. Omit it when
unknown; the check then uses env credentials or the CLI default server.

Interpret the exit code per
[references/agent-guard-activation.md](references/agent-guard-activation.md).
Run it FRESH on every activation — never cache or reuse a previous result.

- **Discover plugins**, **Install / update a plugin**, and **Publish a plugin**
  proceed only on Exit 0 (or the listed disabled-state exception) — they call
  the catalog or download over the network.
- **List currently installed plugins** and **Remove a plugin** are local-only
  (no catalog entitlement required), so they proceed on ANY exit code. Never let
  a non-zero Step 0 stop a "what plugins do I have installed?" or uninstall
  request. If listing with `--check-updates`, that flag needs the registry —
  skip it when Step 0 is non-zero.
- Skill flows (discover / install / manage / publish **skills**) are unchanged
  by this gate; follow their reference files as before.

## Choose a reference file

Pick the row matching the user's intent and read that reference file.
After Step 0 (when required for that intent), jump to the matching file.

| Intent | Read |
|--------|------|
| "What skills are available?" / browse the catalog / list versions / search by name | [references/discovering-skills.md](references/discovering-skills.md) |
| Install or update a skill (latest or a pinned version), or a download is blocked | [references/installing-skills.md](references/installing-skills.md) |
| "What's installed?" / remove an installed skill | [references/managing-installed-skills.md](references/managing-installed-skills.md) |
| Publish / upload / release a skill to the catalog | [references/publishing-skills.md](references/publishing-skills.md) |
| "What plugins are available?" / browse the plugin catalog / list plugin versions / search plugins | Step 0, then [references/discovering-plugins.md](references/discovering-plugins.md) |
| Install or update a plugin (latest or a pinned version) | Step 0, then [references/installing-plugins.md](references/installing-plugins.md) |
| "What plugins are installed?" / remove an installed plugin | [references/managing-installed-plugins.md](references/managing-installed-plugins.md) (Step 0 optional; never blocks) |
| Publish / upload / release a plugin to the catalog | Step 0, then [references/publishing-plugins.md](references/publishing-plugins.md) |

## Prerequisites

- **Read the base `jfrog` skill first.** [`../jfrog/SKILL.md`](../jfrog/SKILL.md)
  owns the shared guards this skill depends on, so this skill does **not** repeat
  them — follow them there:
  - The [environment check](../jfrog/SKILL.md#environment-check) — confirm `jf`
    is installed before the first `jf` call, and install it if missing.
  - The [server selection rules](../jfrog/SKILL.md#server-selection-rules-mandatory)
    — resolve the default `<SID>` once and reuse it, pass `--server-id <SID>`
    after the subcommand on every `jf` call, and use one server per request.
    **Resolve it now, before any `jf` call:**
    ```bash
    jf config show 2>/dev/null \
      | awk '/^Server ID:/{id=$NF} /^Default:[[:space:]]*true/{print id; exit}'
    # stdout: the default server-id; if empty, stop and ask which server to use
    ```
  - The stop-on-error rule — on any `jf` failure, stop and never switch servers.

  One addition specific to this skill: never `cat` or parse
  `~/.jfrog/jfrog-cli.conf.v6` (it can hold access tokens); list servers only
  with `jf config show`, which redacts secrets.
- **Agent Guard registry.** Catalog discovery and repo provisioning run through
  `npx --yes @jfrog/agent-guard`. `<REGISTRY_URL>` is the npm registry that
  provides the `@jfrog/agent-guard` package itself: use `JFROG_AGENT_GUARD_REPO`
  if set, otherwise
  `https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/`. Pass the
  same `<SID>` to Agent Guard as `--server "<SID>"` so it targets the same server
  as your `jf` calls. Agent Guard also reads `JFROG_URL` / `JF_URL` directly when
  set, so make sure the `<SID>` you resolved points at that same host.
- **Resolve the project (`<PROJECT>`) only when needed.**
  It is required for `--list-skills`, `--list-skill-versions`,
  `--provision-skills-repository`, `--list-agent-plugins`,
  `--list-agent-plugin-versions`, and `--provision-agent-plugins-repository`.
  Take it from `JF_PROJECT` or the user.
  There is no non-admin way to look up or validate project keys (the
  `/access/api/v1/projects` list endpoint needs admin), so you cannot
  silently correct a display name to a key. If the value looks like a
  display name (spaces, mixed case) rather than a short slug, ask the
  user to confirm the project **key** specifically. Never assume
  `default`, never invent one. Install, update, remove, and publishing to
  an explicit `--repo` are keyed by skill/plugin **name** and/or **repo**,
  not a project.
- **Bundle manifests differ by type.** Skill bundles require `SKILL.md`
  in the bundle root; plugin bundles require `plugin.json`. Validate the
  correct file before installing or publishing.

## Workflow overview

```mermaid
flowchart TD
    A[User request] --> B{jf CLI installed?}
    B -->|No| C[Ask user to install jf CLI, then continue]
    B -->|Yes| D{Intent}
    C --> D
    D -->|List all skills / versions| E[npx @jfrog/agent-guard --list-skills]
    D -->|Install / update skill| F[Resolve slug + version, then jf skills install/update]
    D -->|List installed skills / remove| G[jf skills list / rm -rf install dir]
    D -->|Publish skill| H[Resolve/provision repo, validate bundle, jf skills publish]
    D -->|Plugin discover / install / update / publish| S0[Step 0: agent-guard-check.mjs]
    S0 -->|Exit 0| P{Plugin intent}
    S0 -->|Exit 2| Stop[Tell user AI Catalog disabled; stop]
    S0 -->|Other non-zero| Abort[Silently abort catalog/download]
    P -->|List all plugins / versions| I[npx @jfrog/agent-guard --list-agent-plugins]
    P -->|Install / update plugin| J[Resolve slug + version, then jf agent plugins install/update]
    P -->|Publish plugin| L[Resolve/provision repo, validate bundle, jf agent plugins publish]
    D -->|List installed plugins / remove| K[jf agent plugins list / rm -rf install dir]
```

## Gotchas

Catalog-specific rules only. The shared `jf` guards — single server per request,
stop-on-error, and cautious mutation — live in the base
[`jfrog` skill](../jfrog/SKILL.md); follow those too. Flow-specific rules live in
the reference files above.

- **Which operations mutate**: install and list are read-mostly; remove, registry
  delete, and publish mutate state — the base skill's cautious-mutation rule
  applies to those three.
- **Session pickup**: installs, updates, and removals usually take effect only at
  the next agent session start, so tell the user to restart.
- **Don't leak the plumbing**: present skills/versions/repos to the user, never
  the `npx`/Agent Guard commands, `--registry`, flags, or cursors. Run follow-ups
  yourself.
- **Use the response templates verbatim**: where a reference file gives a "reply
  using this exact template" block, fill the placeholders and send exactly that,
  with the same wording every time and no extra preamble or commentary.
- **Plugins have no Xray support**: skip all Xray-related handling (no 403
  gating on download, no inline scan on publish, no `--skip-scan` flag) when
  performing any `jf agent plugins` operation.
- **Plugin catalog entitlement**: discover / install / update / publish plugins
  require Step 0 Exit 0 (see
  [references/agent-guard-activation.md](references/agent-guard-activation.md)).
  List-installed and remove do not.
