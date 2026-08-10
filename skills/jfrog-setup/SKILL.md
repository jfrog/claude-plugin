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
   `tool` is not `claude`, skip the remaining steps and reply exactly:

   > Skipping marketplace registration.

2. Ask the user via `AskUserQuestion` whether to use the default name
   or a custom one:

   ```json
   {
     "questions": [{
       "question": "Adding the JFrog AI Catalog marketplace. Register under which name?",
       "header": "Marketplace name",
       "multiSelect": false,
       "options": [
         {"label": "Use default", "description": "Register as jfrog-ai-catalog"},
         {"label": "Use a custom name", "description": "You will provide a kebab-case name (max 128 chars)"}
       ]
     }]
   }
   ```

   On "Use default", pass `jfrog-ai-catalog` to Step 3. On "Use a custom
   name", ask in chat for the exact name, wait for the reply, then pass
   that value to Step 3.

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
