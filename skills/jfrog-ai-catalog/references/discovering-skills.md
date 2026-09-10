# Discovering skills

List-all and versions go through the **Agent Guard**.

## List skills (page through the catalog)

```bash
npx --yes --registry <REGISTRY_URL> @jfrog/agent-guard \
  --list-skills --project "<PROJECT>" --allowed-only [--name <PATTERN>] [--server "<SID>"] [--page-size <N>] [--cursor <C>] [--format json]
```

| Flag | Required | Purpose |
|------|----------|---------|
| `--project <PROJECT>` | **Yes** | AI Catalog project to list. |
| `--allowed-only` | **Yes** | Governance filter. **Always pass it by default** — Agent Guard is unfiltered when the flag is omitted, so leaving it off is what surfaces blocked skills. Only drop it if the user explicitly asks to see blocked/disallowed skills too (e.g. "show me everything", "what's blocked"). |
| `--name <PATTERN>` | No | Find skills by name: server-side, case-insensitive substring, scoped to the project. |
| `--server <SID>` | No | jf CLI config entry to authenticate with (defaults to the resolved single server). |
| `--page-size <N>` | No | Results per page. Pass `50` to stay bounded. The Agent Guard defaults to 500 if omitted. |
| `--cursor <C>` | No | Continuation cursor from a previous page's JSON, to fetch the next page. |
| `--format json` | No | Raw page JSON instead of the default compact TSV (name + last-updated). |

With `--allowed-only`, the listing includes only skills **allowed** by the
project's governance policy. If a skill the user expects isn't in the results,
that's the likely reason
— don't silently retry without `--allowed-only`; tell the user and ask whether
they want to see disallowed skills too.

Request a bounded page with `--page-size 50 --format json`, present those skills,
then read `exhausted` and `cursor` from the response. If `exhausted` is `false`
there are more. Tell the user and offer to fetch the next page with
`--cursor <cursor>`. Do not silently page through the whole catalog.

**Presenting results (use this exact format).** Render the skills as this table,
sorted by name, and nothing else (no commands, URLs, flags, or cursors):

| Skill | Last updated |
|-------|-------------|
| `<name>` | `<lastUpdated>` |

For a `--name` search with no matches, reply with one line instead:

> No skills match "`<query>`".

To offer a follow-up (a skill's versions or repos), ask in plain language
("want the versions for one of these?") and run the command yourself.

## List a repo's skills

To see what is published in one specific skills repository (for example, to check
a repo before or after publishing to it), list it directly with the CLI. This is
repo-scoped (Artifactory registry contents), unlike `--list-skills`, which is
project-scoped:

```bash
jf skills list --repo "<repo>" --server-id "<SID>" --format json
```

Never run a bare `jf skills list` (it errors): always pass `--repo <key>` here, or
`--harness <h>` for installed skills (see `managing-installed-skills.md`).

**Presenting results (use this exact format).** Render the skills as this table,
sorted by name, and nothing else (no commands, URLs, or flags):

Skills in `<repo>`:

| Skill | Version | Description |
|-------|---------|-------------|
| `<name>` | `<version>` | `<description>` |

Include the **Description** column only when the listing provides one (drop it if
every skill's description is empty). If the repo holds no skills, reply with one
line instead:

> No skills published in `<repo>`.

## A skill's versions, then its hosting repos

This is a two-step reveal, not one combined table: show versions first, and
only surface repos once the user has picked a specific version. Both steps
read from the **same** API call and response — do not call the command twice.

```bash
npx --yes --registry <REGISTRY_URL> @jfrog/agent-guard \
  --list-skill-versions --project "<PROJECT>" --skill "<slug>" --allowed-only [--server "<SID>"] [--page-size <N>] [--cursor <C>] [--format json]
# JSON: versions[].version, versions[].locations[].repoKey, versions[].locations[].allowStatus (page through with cursor like above)
```

Same governance rule as `--list-skills` (MLAI-1309): `--allowed-only` by
default, dropped only when the user explicitly wants to see blocked repos
too. Each `locations[]` entry carries its own `allowStatus` — a repo's status
is a per-repo fact, never a per-version one, since a name+version match across
repos is not proof it's the same skill.

**Step 1 — present versions only (use this exact format).** Newest version
first. Do **not** include a repos/"Hosted in" column here — repos are a
separate reveal in step 2:

Versions of `<slug>`:

| Version |
|---------|
| `<version>` |

Then ask which version the user wants (to install, or just to see where it's
hosted) — do not assume the newest one.

**Step 2 — once a version is chosen, present its repos (use this exact
format).** Filter the already-fetched `locations[]` down to that one version
— no new API call:

Repos hosting `<slug>@<version>`:

| Repo |
|------|
| `<repoKey>` |

When `--allowed-only` was omitted and a repo's `allowStatus` is not the
allowed value, append it inline: `<repoKey> (blocked)`.

- **Exactly one repo.** State it plainly ("hosted in `<repoKey>`") — no need
  to ask the user to choose.
- **More than one repo.** Never auto-pick or merge. Ask the user which repo
  they mean before doing anything further (installing, etc.) — see
  `installing-skills.md`'s *Multiple repos host the slug*.
