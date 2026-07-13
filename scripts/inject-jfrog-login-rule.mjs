#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// The built-in JFrog MCP is proxied by Agent Guard;
// when unauthenticated it exposes a single `enable_jfrog_tools` tool and hides
// its real tools.
import process from "node:process";

const rule = [
  "# JFrog MCP tools (Agent Guard)",
  "",
  "The built-in JFrog MCP (`plugin:jfrog:jfrog`) is proxied by JFrog Agent Guard.",
  "When its real tools are not yet available it exposes a single",
  "`enable_jfrog_tools` tool.",
  "",
  "For ANY JFrog / Artifactory / Xray / builds / projects request:",
  "- If an `enable_jfrog_tools` tool is available, call it FIRST. It opens the browser",
  "  for a one-time authorization and then the real JFrog tools appear in the same",
  "  session. This is also how you sign in / log in / connect to JFrog.",
  "- Prefer it over the `jf` CLI when tools are missing: the empty tool list beforehand",
  '  means "call `enable_jfrog_tools`", not "the MCP is broken" — so don\'t jump straight',
  "  to the CLI just because the only tool you see is `enable_jfrog_tools`.",
  "- Don't use the client's built-in MCP authentication for this server — it is a no-op",
  "  here and won't open the browser; call the tool itself.",
  "- The `jf` CLI and the JFrog skill remain the fallback (the skill's Tier 2/3). Use",
  "  them if `enable_jfrog_tools` fails, if the JFrog MCP still can't connect after it",
  "  succeeds, if the user explicitly asks for CLI setup, or for anything the MCP tools",
  "  don't cover.",
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: rule,
    },
  }),
);
