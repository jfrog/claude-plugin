# Vendored skills

The skill packages under `skills/` are vendored from **[jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills)**. They are committed to `main` (and shipped to users via the default branch).

## Source of truth

The upstream repository, the pinned ref, and the directories to copy are declared in [`.vendor.json`](.vendor.json):

```json
{
  "repo": "jfrog/jfrog-skills",
  "pin": "v0.11.0",
  "paths": ["skills"]
}
```

Whatever ref is pinned there should match the contents of `skills/` on `main`.

## Refreshing the pin

The expected workflow is:

1. The JFrog skills team cuts a new release of `jfrog/jfrog-skills` (e.g. `v0.12.0`).
2. They open a PR here that:
   - Bumps `pin` in `.vendor.json` to the new tag.
   - Re-runs the sync script and commits the refreshed `skills/` tree.
   - Bumps `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) so users actually receive the update (Claude Code skips updates when the resolved version is unchanged — see [docs](https://code.claude.com/docs/en/plugin-marketplaces)).
3. We review and merge.

The mechanics of step 2 are run locally:

```bash
node .github/scripts/sync-skills.mjs
git add skills .vendor.json .claude-plugin/plugin.json
```

The script downloads the upstream tarball from `codeload.github.com`, extracts it, and replaces the directories listed in `paths` (only `skills/` today). It is zero-dependency Node — no install step required.

## Why we keep `.vendor.json`

It's the only machine-readable record of which upstream tag the committed `skills/` tree came from. PR reviewers can diff it to see the upstream bump separately from the (much larger) skill content diff, and `sync-skills.mjs` reads it to do the actual download — so the pin always agrees with what was synced.
