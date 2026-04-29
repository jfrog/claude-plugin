#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.env.CLAUDE_PLUGIN_ROOT;
if (!root) {
  process.exit(0);
}

const templatePath = path.join(root, "templates", "jfrog-mcp-management.md");

let template;
try {
  template = readFileSync(templatePath, "utf8");
} catch {
  process.exit(0);
}

const notice =
  "JFrog MCP Gateway: when adding, removing, or listing MCP servers, " +
  "follow the rules below. Do not invent your own approach; do not call " +
  "the JFrog catalog API directly.\n\n";

const payload = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: notice + template,
  },
};

process.stdout.write(JSON.stringify(payload));
