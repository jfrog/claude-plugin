# Installing and updating skills

Install and update both download from the registry, so they share the same
`--repo`/`--quiet` rules, blocked-download (403 / Xray) handling, and
verify-landed check.

## Contents

- When evidence verification fails
- Handling a blocked download (403 / Xray-gated)
- Verify the install landed
- Update an installed skill

Install by **slug** (the registry `slug`/`name`, never a display name). Never
default to "latest" silently — see *Resolve the version* below for when to ask.
**The `jf skills install` command takes no project.** Resolving which repo hosts
the slug uses `--list-skill-versions` (below), which does require `--project`, so
use `<PROJECT>` resolved at session start (see SKILL.md Prerequisites).

```bash
jf skills install "<slug>" \
  --server-id "<SID>" \
  --version "<version>" \
  --repo "<repo>" \
  --harness "<harness>" \
  --quiet
```

`<version>` and `<repo>` are never literal placeholders you fill in blind —
resolve both first (see *Resolve the version* and *Resolve the repo* below).
Never substitute `--version "latest"` here without having actually resolved
that "latest" is the right version per that section.

If the download returns **HTTP 403**, the archive is Xray-gated, not a
permissions or "not found" problem. See *Handling a blocked download
(403 / Xray-gated)* below.

**Always pass `--quiet`.** `jf skills install`/`update` opens an interactive
prompt by default, and an agent's shell has no TTY, so without `--quiet` the
prompt fails (it can abort with `panic: device not configured`). `--quiet` also
defaults to `$CI`, so exporting `CI=true` has the same effect if the flag is ever
unavailable. Run non-interactively and resolve every choice (`--repo`, target)
up front.

**Resolve `<harness>` from the environment check script — never from your model
name.** If `<UA>` is not already known from this session, run
`bash <skill_path>/../jfrog/scripts/check-environment.sh <model-slug>` now and capture
its stdout as `<UA>`. Parse the `tool=<h>` field from `<UA>` and map it to a
`jf` harness name:

| `tool=` value in `<UA>` | `--harness` for `jf skills` |
|-------------------------|------------------------------|
| `claude` | `claude-code` |
| `cursor` | `cursor` |
| `copilot` | `github-copilot` |
| `unknown`, empty, or any other | Ask the user |

If `tool` is `unknown`, empty, or not in the table — do **not** guess. Ask
the user for the desired install path and use `--path <dir>` instead.
**Exception — Kiro (install only):** if you're self-identified as Kiro (IDE
or `kiro-cli`, per your system prompt — `check-environment.sh` doesn't
detect it), `--harness kiro` is rejected by `jf`, so skip asking and use
`--path` with `.kiro/skills` (project) / `~/.kiro/skills` (global, or
`$KIRO_HOME/skills` if `KIRO_HOME` is set) directly. This exception does not
extend to `jf skills list` — see *List currently installed skills* in
`managing-installed-skills.md`.

Choose exactly one install target (these are mutually exclusive):

| Flag | Installs into |
|------|---------------|
| `--harness <name>` | The current agent's resolved skills dir (resolve per above, e.g. `cursor`, `claude-code`). |
| `--global` | Each agent's global directory from config. |
| `--project-dir <dir>` | Project root combined with the agent's project path. |
| `--path <dir>` | Direct: files go under `<dir>/<slug>`. |

**Always resolve and pass `--repo`.** When the platform has more than one skills
repository (the common case), `jf skills install` errors with `multiple skills
repositories found … specify --repo` if you omit it, even when the skill lives
in only one repo. So **the first install step is always** to look up where the
slug is hosted with the Agent Guard:

```bash
npx --yes --registry <REGISTRY_URL> @jfrog/agent-guard \
  --list-skill-versions --project "<PROJECT>" --skill "<slug>" --allowed-only [--server "<SID>"] --format json
# read versions[].version and versions[].locations[].repoKey
```

**Resolve the version and the repo only via `--list-skill-versions`.** The
catalog listing (`--list-skills`, even with `--name`) returns just names, not
repos or versions, so use the versions call above to pick both, never a name
listing. Resolve in this order: version first, then repo for that version.

### Resolve the version

- **The user already named a version** (e.g. "install skill X version 2.0.0").
  Use it directly — confirm it's actually in `versions[]` first, don't assume.
- **Exactly one version exists.** Use it. Don't ask.
- **More than one version exists and the user didn't name one.** Do not
  default to latest. Use the `AskUserQuestion` tool to ask which version to
  install — one option per version, newest first. Fall back to a table +
  plain-language question only if `AskUserQuestion` isn't available on the
  current surface.

### Resolve the repo

Once the version is settled, filter `versions[].locations[]` down to that one
version (no new API call — you already have this from the same response):

- **One repo hosts the slug.** Use it as `--repo <repoKey>` directly. Don't ask.
- **Multiple repos host the slug.** Do not pick silently. Naming a project is not
  a repo choice, so ask even when one repo is project-scoped. Use the
  `AskUserQuestion` tool to ask which repo to install from — one option per
  `repoKey`, with `<slug>@<version>` in the description, so the user picks
  with arrow keys instead of typing a repo name back. Fall back to a table +
  plain-language question only if `AskUserQuestion` isn't available on the
  current surface. Then pass `--repo <chosen>`.

  **A name+version match across repos is not proof it's the same skill.**
  Different repos can hold genuinely different skills (different author,
  different content) under the same slug and version. Never auto-pick "the
  first" or "the newest-looking" repo when more than one holds a match —
  always show every candidate repo and let the user choose.

  **Each repo carries its own governance status (MLAI-1309).** The skill
  always passes `--allowed-only` to `--list-skill-versions`, so only
  governance-allowed repos ever come back and every candidate you show the
  user is installable. Never re-run without the flag to surface blocked repos
  — if a repo the user expects is missing, say it isn't governance-allowed for
  this project and stop there.

## When evidence verification fails

If install fails with `evidence verification failed … no evidence found`, the
skill has **no signed evidence/attestation** (proof it's genuine and scanned).
This is a security control. **Do not silently bypass it.** Stop and ask using
**this exact template**:

> `<slug>@<version>` has no signed evidence (proof it is genuine and scanned).
> Installing it skips that security check. Do you want to install it anyway?

Only if the user explicitly agrees, re-run with
`JFROG_SKILLS_DISABLE_QUIET_FAILURE=true`. Never set that flag on your own.

## Handling a blocked download (403 / Xray-gated)

A `jf skills install`/`update` download can return **HTTP 403** even when the
slug, version, and repo are all correct, because the skill archive is gated by Xray
and Artifactory will not serve it until the scan resolves. Do **not** report
this as a permissions or "not found" problem. Query the skill's Xray status to
find out why (the path is the archive `<slug>/<version>/<slug>-<version>.zip`,
URL-encoded):

```bash
jf api --server-id "<SID>" \
  '/artifactory/api/skills/<repo>/xrayStatus?path=<slug>%2F<version>%2F<slug>-<version>.zip'
```

Interpret the `status` field in the response:

- **`SCAN_IN_PROGRESS`.** Xray is still scanning the archive. The download is
  temporarily gated, not blocked. **Do not retry in a tight loop.** Reply using
  **this exact template**:

  > `<slug>@<version>` is still being scanned by Xray and isn't available to
  > download yet. I can retry in a moment if you'd like.

  If it stays `SCAN_IN_PROGRESS` after a couple of polls, switch to **this exact
  template** instead:

  > `<slug>@<version>` is still being scanned by Xray and is taking longer than
  > expected. Try again later, or check with your JFrog administrator if it never
  > clears.
- **Blocked by a policy** (a blocked/violating status, with the offending
  policy in the response body). The skill is **blocked by an Xray policy**.
  Stop. Do not retry. Reply using **this exact template**, filling the
  placeholders:

  > `<slug>@<version>` is **blocked by the Xray policy `<policy-name>`** and
  > cannot be installed. Contact your JFrog administrator to review or resolve
  > the policy.
- **Any other status, or a non-zero `jf api` exit** (`jf api` signals a non-2xx
  response via its exit code plus a stderr `[Warn] … returned NNN` line — see the
  base `jfrog` skill's *CLI and `jf api`* gotchas). Treat as an operational
  failure (auth, endpoint disabled): the deliberate **free-form** case — report
  the CLI error verbatim (no template), but still strip the `Trace ID`.

## Verify the install landed

After install, confirm the `SKILL.md` exists at the resolved install location
before reporting success:

```bash
test -f "<install-dir>/<slug>/SKILL.md" && echo "installed" || echo "MISSING SKILL.md"
```

If the file is missing, report the failure. Do not claim success.

On success, reply using **this exact template**:

> Installed `<slug>@<version>` from `<repo>` into `<harness>`.
> Restart your agent session to load it.

## Update an installed skill

To upgrade an installed skill to a newer version, use the CLI (it re-downloads
and reinstalls in place):

```bash
jf skills update "<slug>" --server-id "<SID>" --harness "<harness>" --version "latest" --quiet
# Preview without touching Artifactory:
jf skills update "<slug>" --server-id "<SID>" --harness "<harness>" --dry-run
# Reinstall even if already at the target version:
jf skills update "<slug>" --server-id "<SID>" --harness "<harness>" --force --quiet
```

Use the same install-target flag (`--harness`/`--global`/`--project-dir`/
`--path`) the skill was installed with. After updating, re-verify the `SKILL.md`
(see *Verify the install landed* above). If the update download 403s, handle it
as in *Handling a blocked download* above.

On success, reply using **this exact template**:

> Updated `<slug>` to `<version>` (`<harness>`).
> Restart your agent session to load it.

If the skill was already current:

> `<slug>` is already at the latest version (`<version>`). Nothing to update.
