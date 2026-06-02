# Vendored skills

The skill packages under `skills/` are vendored from **[jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills)** at release time. They are **not** committed to `main` — `skills/` is gitignored, and the synced tree lives only on the release tag.

## Source of truth

The upstream repository, the pinned ref, and the directories to copy are declared in [`.vendor.json`](.vendor.json):

```json
{
  "repo": "jfrog/jfrog-skills",
  "pin": "v0.11.0",
  "paths": ["skills"]
}
```

Whatever ref is pinned there is what end users get when they install the plugin from the corresponding release tag.

## How sync works

[`.github/scripts/sync-skills.mjs`](.github/scripts/sync-skills.mjs) downloads the upstream tarball from `codeload.github.com`, extracts it, and copies each path listed in `paths` into the repo root. It runs:

- **In CI**, on every pull request and push to `main` (see [`.github/workflows/validate.yml`](.github/workflows/validate.yml)) — exercises the synced tree against `scripts/validate-claude-plugin.mjs`.
- **In CI**, at release time (see [`.github/workflows/release.yml`](.github/workflows/release.yml)) — produces the actual content shipped on the release tag.
- **Locally**, when contributors want to test the plugin against the real skill content. The synced `skills/` tree is gitignored.

## Refreshing the pin

1. Edit `pin` in `.vendor.json` to the new tag (e.g. `v0.12.0`).
2. (Optional) Run `node .github/scripts/sync-skills.mjs` locally to preview.
3. Open a PR with the bump. CI will sync against the new pin and validate.
4. Merge, then trigger the **Release plugin** workflow in GitHub Actions.

To override the pin for a one-off local run without editing the file, set `SKILLS_REF`:

```bash
SKILLS_REF=v0.12.0 node .github/scripts/sync-skills.mjs
```

The release workflow exposes the same override as a `skills_version` workflow input.
