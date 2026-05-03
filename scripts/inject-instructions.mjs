#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.env.JF_MCP_GATEWAY_FORCE_ENABLE !== "true") {
  process.exit(0);
}

// Derive the plugin root from this script's own location instead of relying
// on CLAUDE_PLUGIN_ROOT, which Claude Code interpolates into the hook command
// string but does not always export to the subprocess.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let template;
try {
  template = readFileSync(
    path.join(root, "templates", "jfrog-mcp-management.md"),
    "utf8",
  );
} catch {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: template,
    },
  }),
);
