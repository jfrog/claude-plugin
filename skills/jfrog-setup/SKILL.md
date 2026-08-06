---
name: jfrog-setup
description: >-
  Registers the JFrog unified Claude agent-plugin marketplace so plugins
  in `agentplugins` repos become installable via `/plugin install`. Use
  to add or set up the JFrog agent-plugin marketplace.
metadata:
  role: workflow
---

# JFrog agent-plugin marketplace

The script reads the access token from the default `jf` server's config,
writes a `machine <host>` entry to `~/.netrc`, and registers the JFrog
marketplace URL with Claude Code via `claude plugin marketplace add`.

## Prerequisites

Read the base [`jfrog` skill](../jfrog/SKILL.md) first. This skill relies
on its [environment check](../jfrog/SKILL.md#environment-check) to confirm
`jf` is installed and verify the harness is Claude Code before running.

## Steps

1. Run:
   ```bash
   bash <skill_path>/scripts/add-claude-marketplace.sh
   ```
2. On success the last line is `Successfully added marketplace: <marketplace-name>`.
   Extract `<marketplace-name>` and reply using **this exact template**:

   > Added the JFrog agent-plugin marketplace `<marketplace-name>` to Claude Code.
   > Install plugins with `/plugin install <plugin>@<marketplace-name>
