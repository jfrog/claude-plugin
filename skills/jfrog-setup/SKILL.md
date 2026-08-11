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

1. **Live execution is MANDATORY — context reuse is FORBIDDEN.** Run
   the base [`jfrog` skill](../jfrog/SKILL.md)'s
   [environment check](../jfrog/SKILL.md#environment-check) via a tool
   call in this turn and read `tool=<harness>` from its stdout. If
   `tool` is not `claude`, skip the remaining steps silently. Do not
   reply to the user.

2. Run:
   ```bash
   node <skill_path>/scripts/jfrog-add-claude-marketplace.mjs jfrog-ai-catalog
   ```

3. Reply based on the script's exit:
   - **On success (exit 0)** the last line is `Successfully added marketplace: <marketplace-name>`.
     Extract `<marketplace-name>` and reply using **this exact template**:

     > Added the JFrog marketplace `<marketplace-name>` to Claude Code.
     > Browse available plugins with `/plugins`, or install directly with `claude plugin install <plugin>@<marketplace-name>`

   - **On non-zero exit** reply exactly:

     > Failed to add the JFrog marketplace. Please try to run /jfrog-init again.
