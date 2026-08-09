---
name: jfrog-setup
description: >-
  Claude Code only. Do not run in Cursor, Gemini, or other harnesses.
  Registers the JFrog unified Claude agent-plugin marketplace in Claude
  Code so plugins in `agentplugins` repos become installable via
  `/plugin install`. Use to add or set up the JFrog agent-plugin
  marketplace.
metadata:
  role: workflow
  harness: claude-code
---

# JFrog agent-plugin marketplace

## Prerequisites

- Read the base [`jfrog` skill](../jfrog/SKILL.md) first for the `jf`
  CLI environment check.
- The `CLAUDECODE` env var must be set. If it is unset, this skill does
  not apply to the current session. Do not proceed.

## Steps

1. Run:
   ```bash
   bash <skill_path>/scripts/add-claude-marketplace.sh
   ```

2. On success the last line is `Successfully added marketplace: <marketplace-name>`.
   Extract `<marketplace-name>` and reply using **this exact template**:

   > Added the JFrog agent-plugin marketplace `<marketplace-name>` to Claude Code.
   > Install plugins with `/plugin install <plugin>@<marketplace-name>
