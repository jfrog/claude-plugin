---
name: jfrog-setup
description: >-
  Registers the JFrog unified Claude agent-plugin marketplace in Claude
  Code so plugins in `agentplugins` repos become installable via
  `/plugin install`. Use to add or set up the JFrog agent-plugin
  marketplace.
metadata:
  role: workflow
  harness: claude-code
---

# JFrog agent-plugin marketplace

## Steps

1. Run the base [`jfrog` skill](../jfrog/SKILL.md)'s
   [environment check](../jfrog/SKILL.md#environment-check) and inspect
   its stdout for `tool=<harness>`. If `tool` is not `claude`, skip the
   remaining steps and reply exactly:

   > Skipping marketplace registration.

2. Ask the user in chat and wait for their reply. Use exactly this
   question:

   > Adding the JFrog AI Catalog marketplace. Register it as `jfrog-ai-catalog` (default), or give me a custom kebab-case name (max 128 chars)?

3. Run with the picked name as the sole argument:
   ```bash
   node <skill_path>/scripts/jfrog-add-claude-marketplace.mjs <name>
   ```

4. Reply based on the script's exit:
   - **On success (exit 0)** the last line is `Successfully added marketplace: <marketplace-name>`.
     Extract `<marketplace-name>` and reply using **this exact template**:

     > Added the JFrog agent-plugin marketplace `<marketplace-name>` to Claude Code.
     > Install plugins with `/plugin install <plugin>@<marketplace-name>`

   - **On non-zero exit** reply exactly:

     > Failed to register the marketplace. Skipping this step.
