# Contributing to JFrog Claude Code Plugin

Thank you for your interest in contributing! This project is maintained by JFrog and licensed under the [Apache License 2.0](LICENSE).

## Contributor License Agreement (CLA)

All contributors must sign the [JFrog CLA](https://jfrog.com/cla/) before contributions can be merged. A CLA check runs automatically on every pull request — follow the prompts to sign if you haven't already.

## How to Contribute

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes, ensuring they follow the existing code style and project conventions.
3. **Validate** locally:

```bash
node scripts/validate-claude-plugin.mjs
```

This checks `.claude-plugin/plugin.json` and walks every `skills/*/SKILL.md` for required YAML frontmatter. Before a release or directory submission, also run **`claude plugin validate`** (requires [Claude Code](https://code.claude.com/docs) CLI).

4. **Test** by loading the repository as the plugin (the repo root is the plugin root):

```bash
claude --plugin-dir .
```

Exercise the skills you changed (for example `/jfrog:<skill-name>`). Run `/reload-plugins` after editing plugin files.

5. **Commit** with a clear, descriptive message.
6. Open a **pull request** against `main` with a summary of what changed and why.

### Updating the vendored skills

The `skills/` tree is vendored from [jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills) and committed to `main` — see [`VENDOR.md`](VENDOR.md) for the full flow. To regenerate the tree locally against the pin in [`.github/scripts/sync-skills-vendor.json`](.github/scripts/sync-skills-vendor.json):

```bash
node .github/scripts/sync-skills.mjs
```

This downloads the pinned upstream tarball and replaces the contents of `skills/`. Commit the result alongside any pin/version bumps.

## Pre-release checklist

- [ ] `node scripts/validate-claude-plugin.mjs` passes.
- [ ] `claude plugin validate` passes (before directory submission or major releases).
- [ ] Version bumped in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) — required on every PR to `main`, not only when the plugin itself changes.
- [ ] No secrets, credentials, or files under `**/local-cache/` committed.
- [ ] If the skill tree changed: `pin` in `.github/scripts/sync-skills-vendor.json` matches the upstream tag the new tree was generated from.
- [ ] Smoke-test: `claude --plugin-dir .` from the repo root.

### Submitting to the Claude plugin directory

Use [Submitting your plugin](https://claude.com/docs/plugins/submit). Submit the **public GitHub URL** of this repository — the **repository root** is the plugin root (manifest in `.claude-plugin/`, skills committed under `skills/`, vendored from [jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills)).

Compliance: [Anthropic Software Directory Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms), [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).

## Releasing

Every merge to `main` releases, so **every** PR to `main` must bump `.version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) — including docs- and CI-only changes. That manifest is the only place the version lives.

Every push to `main` compares the manifest version against the latest release tag: if the version is newer, a release proceeds; if it matches the latest tag, the workflow fails with a clear "already released" error; if it is older, it fails with a revert warning.

A merge without a bump therefore turns `Release` red. That is by design, not a bug to work around: the bump is reviewed in the PR that makes it, and failing loudly beats silently skipping a release or re-tagging a shipped version.

The workflow reads the version from the manifest, runs the same plugin-layout check as the `validate` PR workflow, packages the tracked files at `HEAD` (minus `.github/`) into `release.zip`, and creates the `vX.Y.Z` tag as part of publishing the GitHub Release.

Three things to know before changing it:

- Validation runs inside the release job. `validate.yml` triggers on the same push, but as an independent workflow, so it can be red while a release still goes out. Re-running its check in the release job is what actually gates the release on it.
- The tag is created by the release, not before it. `gh release create --target` does both in one API call, so a failed run can't leave a tag behind with no release attached to it.
- The rollback step only runs when the gate itself passed. A gate failure means the version was already released by an earlier run, and deleting that release would destroy something already shipped.

## Reporting Issues

Open a [GitHub issue](https://github.com/jfrog/claude-plugin/issues) with:

- A clear title and description of the problem.
- Steps to reproduce (if applicable).
- Expected vs. actual behavior.

## Code Guidelines

- Keep changes focused — one logical change per PR.
- Follow existing patterns and naming conventions in the codebase.
- Do not commit secrets, credentials, or API keys.
- Add copyright headers to new source files:

```
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
```

## Code of Conduct

Be respectful and constructive. We are committed to providing a welcoming and inclusive experience for everyone.

## Questions?

Reach out to the JFrog DevRel team at devrel@jfrog.com.
