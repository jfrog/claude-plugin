#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.env.CLAUDE_PLUGIN_ROOT;
if (!root || process.env.JF_MCP_GATEWAY_FORCE_ENABLE !== "true") {
  process.exit(0);
}

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
