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

Before a release or directory submission, also run **`claude plugin validate`** (requires [Claude Code](https://code.claude.com/docs) CLI).

4. **Test** by loading the repository as the plugin (the repo root is the plugin root):

```bash
claude --plugin-dir .
```

Exercise the skills you changed (for example `/jfrog:<skill-name>`). Run `/reload-plugins` after editing plugin files.

5. **Commit** with a clear, descriptive message.
6. Open a **pull request** against `main` with a summary of what changed and why.

## Pre-release checklist

- [ ] `node scripts/validate-claude-plugin.mjs` passes.
- [ ] `claude plugin validate` passes (before directory submission or major releases).
- [ ] Version bumped in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) when the plugin changes.
- [ ] No secrets, credentials, or files under `**/local-cache/` committed.
- [ ] Smoke-test: `claude --plugin-dir .` from the repo root.

### Submitting to the Claude plugin directory

Use [Submitting your plugin](https://claude.com/docs/plugins/submit). Submit the **public GitHub URL** of this repository — the **repository root** is the plugin root (manifest in `.claude-plugin/`, skills in `skills/`).

Compliance: [Anthropic Software Directory Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms), [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).

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
