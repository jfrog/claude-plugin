---
name: jfrog-setup
description: >-
  Registers the JFrog unified Claude agent-plugin marketplace in Claude
  Code so plugins in `agentplugins` repos become installable via
  `/plugin install`. Use to add or set up the JFrog agent-plugin
  marketplace.
disable-model-invocation: true
compatibility: >-
  Requires Node.js (>= 18) and network access to the JFrog platform.
allowed-tools: Bash Read
metadata:
  role: workflow
  harness: claude-code
---

# JFrog agent-plugin marketplace

## Prerequisites

Read the base [`jfrog` skill](../jfrog/SKILL.md) and run its
[environment check](../jfrog/SKILL.md#environment-check).

## Steps

1. Inspect the environment-check stdout for `tool=<harness>`. If `tool`
   is not `claude`, skip the remaining steps and reply exactly:

   > Skipping marketplace registration.

2. Run:
   ```bash
   node <skill_path>/scripts/jfrog-add-claude-marketplace.mjs
   ```

3. On success the last line is `Successfully added marketplace: <marketplace-name>`.
   Extract `<marketplace-name>` and reply using **this exact template**:

   > Added the JFrog agent-plugin marketplace `<marketplace-name>` to Claude Code.
   > Install plugins with `/plugin install <plugin>@<marketplace-name>
